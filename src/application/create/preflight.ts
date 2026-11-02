import { networkDriver } from '#application/catalog/networks';
import { bindProvider } from '#application/catalog/providers';
import { commandError } from '#application/failures';
import { resolveCreateInputs } from '#application/input';
import {
  networkManagement,
  resolveEnrollmentKey,
} from '#application/input/management';
import { retainEnteredProviderToken } from '#application/input/prompts';
import {
  resolvePluginActions,
  validateMarketplaceSources,
} from '#application/plugins';
import { runOperation, checkOperation } from '#kernel/operation';

import { blockedPreparation, inputFailure } from './blockers';
import { authorizationFailure } from './failure';
import { promptCreatePluginOptions } from './plugins';
import { createPreflightSummary } from './reminders';
import { confirmCreation, reviewCreatePlan } from './review';

import type { CommandRequest } from '#application/contracts';
import type { CommandError } from '#application/failures';
import type { ResolvedInputs } from '#application/input/types';
import type { HarnessPluginActions } from '#application/plugins';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type {
  ProviderDriver,
  NetworkExitNode,
} from '#application/ports/drivers';
import type { Interaction } from '#application/ports/interaction';

import type { CreatePreparation } from './context';
import type { RequiredCreateValues, ReviewContext } from './review';

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

/**
 * resolve, verify, and confirm all deterministic inputs before workstation creation
 * @param dependencies the registered drivers, the profile defaults, the guest mechanics, what this computer provides
 * @param request parsed create command and explicit selections
 * @param interaction optional inline review and consent prompts
 * @returns complete provisioning context or a preflight/cancel result
 */
export async function prepareCreate(
  dependencies: ApplicationDependencies,
  request: CommandRequest,
  interaction?: Interaction,
): Promise<CreatePreparation> {
  const input = await resolveCreateInputs(
    dependencies,
    request.options,
    interaction,
  );
  // the runtime environment is written only once the plan has run, so a
  // restricted variable refuses here, before the provider creates anything
  dependencies.guest.native.assertRuntimeEnv(input.runtimeEnv);
  const blocked = await inputFailure(dependencies, input);
  if (blocked) {
    return blocked;
  }
  const values = { name: input.name!, token: input.providerToken! };
  const plugins = await resolveCreatePlugins(dependencies, {
    request,
    input,
    interaction,
  });
  const provider = bindProvider(
    dependencies.registry,
    input.profile.provider,
    values.token,
  );
  // a required tool no source serves on the provider's image refuses here,
  // before the provider creates anything
  dependencies.guest.plan.assertImageTools(provider, input.profile);
  const names = await checkProviderAndNetwork(dependencies, {
    provider,
    values,
    input,
  });
  const refused = await providerCheckFailure(dependencies, names, {
    input,
    request,
    interaction,
    name: values.name,
  });
  if (refused) {
    return refused;
  }
  const preflight = createPreflightSummary(
    dependencies,
    input,
    names.verifiedExitNode,
  );

  return authorizeCreate(dependencies, {
    values,
    input,
    plugins,
    verifiedExitNode: names.verifiedExitNode,
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
 * @param dependencies the registered drivers, what this computer provides
 * @param names provider and network check outcomes
 * @param context resolved inputs, request, prompts and requested name
 * @param context.input resolved create inputs
 * @param context.request parsed create command
 * @param context.interaction optional inline prompts
 * @param context.name requested workstation name
 * @returns the failure to return, or undefined when provisioning may continue
 */
async function providerCheckFailure(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'host'>,
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
    await retainEnteredProviderToken(dependencies, input, {
      interaction,
      options: request.options,
    });
  }
  const [firstIssue] = names.issues;
  if (firstIssue) {
    return blockedPreparation(
      firstIssue.code,
      'Provider preflight checks failed; no workstation was created',
      { details: names.issues.map((issue) => issue.message) },
    );
  }

  return names.collision
    ? blockedPreparation('CONFLICT', `Workstation ${name} already exists`, {
        machine: name,
      })
    : undefined;
}

/** what the plugin selection of a create depends on */
interface CreatePluginsParams {
  /** parsed create command */
  request: CommandRequest;
  /** resolved create inputs */
  input: ResolvedInputs;
  /** optional inline plugin prompts */
  interaction?: Interaction;
}

/**
 * selects the harness plugin actions and validates their marketplace sources before any provider call
 * @param dependencies the registered drivers, what this computer provides
 * @param params parsed command, resolved inputs and optional prompts
 * @returns the plugin actions to install
 */
async function resolveCreatePlugins(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'host'>,
  params: CreatePluginsParams,
): Promise<HarnessPluginActions> {
  const { request, input, interaction } = params;
  const { harnesses } = input.profile;
  const options = await promptCreatePluginOptions(
    request.options,
    harnesses,
    interaction,
  );
  const actions = resolvePluginActions(options, harnesses);
  await validateMarketplaceSources(dependencies, {
    actions,
    accessToken: marketplaceToken(request, input),
    requireSelectedPluginCoverage: true,
  });

  return actions;
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
 * presents verified inputs, confirms the operation, and obtains enrolment authorisation
 * @param dependencies the registered drivers
 * @param context caller-side preflight evidence, selected native code, and operation
 * @returns authorised provisioning context or cancellation result
 */
async function authorizeCreate(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
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
  reviewCreatePlan(dependencies, context);
  const declined = await confirmCreation(
    dependencies,
    { name: values.name, request, plugins, profile: input.profile },
    interaction,
  );
  if (declined) {
    return blockedPreparation('CANCELLED', declined);
  }
  const network = networkDriver(dependencies.registry, input.profile.network);
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

/** the named inputs of check provider and network */
interface CheckProviderAndNetworkParams {
  /** authenticated provider driver */
  provider: ProviderDriver;
  /** required create inputs */
  values: RequiredCreateValues;
  /** caller-side network management credential, if available */
  input: ResolvedInputs;
}

/**
 * checks the provider name and exact network hostname before creating a workstation
 * @param dependencies the registered drivers
 * @param params the call's inputs: provider, values, input
 * @returns collision status, verified exit-node identity, and all failed checks
 */
async function checkProviderAndNetwork(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  params: CheckProviderAndNetworkParams,
): Promise<CreateProviderChecks> {
  const { provider, values, input } = params;
  const network = networkDriver(dependencies.registry, input.profile.network);
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
        : preflight.value.problems.map((problem) => commandError(problem))),
    ],
  };
}
