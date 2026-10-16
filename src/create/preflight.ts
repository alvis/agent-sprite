import { catalog } from '#core/catalog';
import { networkDriver } from '#core/networks';
import { prerequisiteDetails, providerPreflight } from '#core/preflight';
import { bindProvider } from '#core/providers';
import { commandError } from '#errors';
import { resolveCreateInputs, retainEnteredProviderToken } from '#input';
import { networkManagement, resolveEnrollmentKey } from '#input/management';
import { assertImageTools } from '#integrations/guest/plan/assemble';
import { assertRuntimeEnv } from '#integrations/native/git';
import { machineNameProblem } from '#machine';
import {
  runOperation,
  checkOperation,
  promptUnavailableDetail,
} from '#operation';
import { resolvePluginActions, validateMarketplaceSources } from '#plugins';

import { authorizationFailure } from './failure.js';
import { promptCreatePluginOptions } from './plugins.js';
import { createPreflightSummary } from './reminders.js';
import { confirmCreation, reviewCreatePlan } from './review.js';

import type {
  CommandError,
  CommandErrorCode,
  CommandRequest,
  Interaction,
} from '#command/contracts';
import type {
  NetworkExitNode,
  PrerequisiteProblem,
  ProviderDriver,
} from '#drivers/contracts';
import type { ResolvedInputs } from '#input/types';

import type { CreatePreparation } from './preparation.js';
import type { RequiredCreateValues, ReviewContext } from './review.js';

interface CreateProviderChecks {
  /** the provider answered with the entered credential */
  providerAccepted: boolean;
  collision: boolean;
  verifiedExitNode?: NetworkExitNode;
  issues: CommandError[];
}

interface CreateAuthorizationContext extends ReviewContext {
  request: CommandRequest;
  provider: ProviderDriver;
}

export type { CreatePreparation } from './preparation.js';

/**
 * resolve, verify, and confirm all deterministic inputs before workstation creation
 * @param request parsed create command and explicit selections
 * @param interaction optional inline review and consent prompts
 * @returns complete provisioning context or a preflight/cancel result
 */
export async function prepareCreate(
  request: CommandRequest,
  interaction?: Interaction,
): Promise<CreatePreparation> {
  const input = await resolveCreateInputs(request.options, interaction);
  const { profile } = input;
  // the runtime environment is written only once the plan has run, so a
  // restricted variable refuses here, before the provider creates anything
  assertRuntimeEnv(input.runtimeEnv);
  const blocked = await inputFailure(input);
  if (blocked) {
    return blocked;
  }
  const values = requireCreateValues(input);
  const pluginOptions = await promptCreatePluginOptions(
    request.options,
    profile.harnesses,
    interaction,
  );
  const plugins = resolvePluginActions(pluginOptions, profile.harnesses);
  await validateMarketplaceSources(
    plugins,
    marketplaceToken(request, input),
    true,
  );
  const provider = bindProvider(profile.provider, values.token);
  // a required tool no source serves on the provider's image refuses here,
  // before the provider creates anything
  assertImageTools(provider, profile);
  const names = await checkProviderAndNetwork(provider, values, input);
  const refused = await providerCheckFailure(names, {
    input,
    request,
    interaction,
    name: values.name,
  });
  if (refused) {
    return refused;
  }
  const { verifiedExitNode } = names;
  const preflight = createPreflightSummary(input, verifiedExitNode);

  return authorizeCreate({
    values,
    input,
    plugins,
    verifiedExitNode,
    interaction,
    preflight,
    request,
    provider,
  }).catch((error: unknown) => {
    checkOperation();

    return authorizationFailure(error);
  });
}

/**
 * retains a provider credential the provider accepted, then reports the first
 * blocking provider or network check
 * @param names provider and network check outcomes
 * @param context resolved inputs, request, prompts and requested name
 * @param context.input resolved create inputs
 * @param context.request parsed create command
 * @param context.interaction optional inline prompts
 * @param context.name requested workstation name
 * @returns the failure to return, or undefined when provisioning may continue
 */
async function providerCheckFailure(
  names: CreateProviderChecks,
  context: {
    input: ResolvedInputs;
    request: CommandRequest;
    interaction?: Interaction;
    name: string;
  },
): Promise<CreatePreparation | undefined> {
  const { input, request, interaction, name } = context;
  if (names.providerAccepted) {
    await retainEnteredProviderToken(input, {
      interaction,
      options: request.options,
    });
  }
  const [firstIssue] = names.issues;
  if (firstIssue) {
    return result(
      firstIssue.code,
      'Provider preflight checks failed; no workstation was created',
      { details: names.issues.map((issue) => issue.message) },
    );
  }

  return names.collision
    ? result('CONFLICT', `Workstation ${name} already exists`, {
        machine: name,
      })
    : undefined;
}

/**
 * reports missing inputs, an invalid workstation name and provider
 * prerequisite problems together, before any provider call
 * @param input resolved create inputs
 * @returns the INPUT failure, or undefined when nothing blocks provisioning
 */
async function inputFailure(
  input: ResolvedInputs,
): Promise<CreatePreparation | undefined> {
  const { credential } =
    catalog.providers[input.profile.provider].prerequisites;
  const prerequisites = await providerPreflight(input.profile.provider, {
    token: input.providerToken,
    source: input.sources[credential.environment],
  });
  const nameProblem = input.name ? machineNameProblem(input.name) : undefined;
  const invalid = nameProblem ? [nameProblem] : [];
  if (
    input.missing.length === 0 &&
    invalid.length === 0 &&
    prerequisites.length === 0
  ) {
    return undefined;
  }

  return result('INPUT', inputFailureMessage(input.missing, invalid), {
    details: missingCreateDetails(
      [...input.missing, ...invalid],
      prerequisites,
    ),
  });
}

/**
 * summarises what blocks provisioning before any provider call
 * @param missing required inputs unresolved before provider work
 * @param invalid supplied inputs that cannot be used
 * @returns the headline of the INPUT failure
 */
function inputFailureMessage(
  missing: readonly string[],
  invalid: readonly string[],
): string {
  if (missing.length > 0) {
    return 'Required provisioning inputs are missing';
  }

  return invalid.length > 0
    ? 'Provisioning inputs are invalid'
    : 'Provider prerequisites are missing or misconfigured';
}

/**
 * selects the GitHub token marketplace sources may use; only github.com receives it
 * @param request parsed create command
 * @param input resolved GitHub token
 * @returns the token for github.com marketplace sources, if any
 */
function marketplaceToken(
  request: CommandRequest,
  input: ResolvedInputs,
): string | undefined {
  const host = request.options.githubHost;

  return host && host.toLowerCase() !== 'github.com'
    ? undefined
    : input.githubToken;
}

/**
 * aggregates missing inputs, provider prerequisite problems and the actual
 * implicit prompt blocker into one failure
 * @param missing required inputs unresolved, or supplied but invalid, before provider work
 * @param prerequisites problems the provider preflight found, each with its fix
 * @returns safe details for the typed INPUT failure
 */
function missingCreateDetails(
  missing: readonly string[],
  prerequisites: readonly PrerequisiteProblem[],
): string[] {
  const promptHint = promptUnavailableDetail();

  return [
    ...missing,
    ...prerequisiteDetails(prerequisites),
    ...(promptHint ? [promptHint] : []),
  ];
}

/**
 * presents verified inputs, confirms the operation, and obtains enrolment authorisation
 * @param context caller-side preflight evidence, selected native code, and operation
 * @returns authorised provisioning context or cancellation result
 */
async function authorizeCreate(
  context: CreateAuthorizationContext,
): Promise<CreatePreparation> {
  const {
    values,
    input,
    plugins,
    verifiedExitNode,
    interaction,
    preflight,
    request,
    provider,
  } = context;
  reviewCreatePlan(context);
  const declined = await confirmCreation(
    { name: values.name, request, plugins, profile: input.profile },
    interaction,
  );
  if (declined) {
    return result('CANCELLED', declined);
  }
  const network = networkDriver(input.profile.network);
  const authKey = network.inputs
    ? await resolveEnrollmentKey(network, input)
    : undefined;

  return {
    kind: 'ready',
    context: {
      options: request.options,
      input,
      name: values.name,
      token: values.token,
      effectiveExitNode: input.profile.options.isExitNodeEnabled
        ? (verifiedExitNode?.ip ?? input.exitNode)
        : undefined,
      authKey,
      plugins,
      preflight,
      provider,
    },
  };
}

/**
 * checks the provider name and exact network hostname before creating a workstation
 * @param provider authenticated provider driver
 * @param values required create inputs
 * @param input caller-side network management credential, if available
 * @returns collision status, verified exit-node identity, and all failed checks
 */
async function checkProviderAndNetwork(
  provider: ProviderDriver,
  values: RequiredCreateValues,
  input: ResolvedInputs,
): Promise<CreateProviderChecks> {
  const network = networkDriver(input.profile.network);
  const { isExitNodeEnabled } = input.profile.options;
  const [taken, preflight] = await runOperation(async () =>
    Promise.allSettled([
      provider.isNameTaken(values.name),
      network.preflight({
        hostname: values.name,
        management: networkManagement(input),
        exitNode: isExitNodeEnabled ? input.exitNode : undefined,
      }),
    ]),
  );
  const checked =
    preflight.status === 'fulfilled' ? preflight.value : undefined;

  return {
    providerAccepted: taken.status === 'fulfilled',
    collision: taken.status === 'fulfilled' && taken.value,
    verifiedExitNode: checked?.exitNode,
    issues: [
      ...(taken.status === 'rejected' ? [commandError(taken.reason)] : []),
      ...(preflight.status === 'rejected'
        ? [commandError(preflight.reason)]
        : (checked?.problems ?? []).map((problem) => commandError(problem))),
    ],
  };
}

/**
 * narrows mandatory values after the aggregate missing-input check
 * @param input resolved create input values
 * @returns values required to create one workstation
 */
function requireCreateValues(input: ResolvedInputs): RequiredCreateValues {
  const { name, providerToken: token } = input;
  if (!name || !token) {
    throw new Error('Validated create inputs were unavailable');
  }

  return { name, token };
}

/**
 * returns a structured preflight outcome before any workstation exists
 * @param code machine-readable preflight status
 * @param message safe explanation for the caller
 * @param extra optional collision or missing-input detail
 * @param extra.machine exact machine name when a collision occurred
 * @param extra.details aggregate missing inputs when preflight failed
 * @returns a non-successful create preparation
 */
function result(
  code: CommandErrorCode,
  message: string,
  extra: { machine?: string; details?: string[] } = {},
): CreatePreparation {
  return {
    kind: 'result',
    result: {
      command: 'create',
      ok: false,
      error: { code, message, ...extra },
    },
  };
}
