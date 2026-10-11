import { commandError, CommandFault } from '#errors';
import { resolveCreateInputs } from '#input';
import { spritesTokenGuidance } from '#input/token-guidance';
import { createSpritesClient } from '#integrations/sprites';
import {
  assertTailnetHostnameAvailable,
  createTailscaleAuthKey,
  resolveExitNode,
} from '#integrations/tailscale';
import { validateMachineName } from '#machine';
import {
  runOperation,
  checkOperation,
  publishStatus,
  promptUnavailableDetail,
} from '#operation';
import {
  hasActions,
  resolvePluginActions,
  validateMarketplaceSources,
} from '#plugins';

import { authorizationFailure } from './failure.js';
import { promptCreatePluginOptions } from './plugins.js';

import { createPreflightSummary } from './reminders.js';

import type { SpritesClient } from '@fly/sprites';

import type {
  CommandError,
  CommandErrorCode,
  CommandRequest,
  Interaction,
} from '#command/contracts';
import type { ResolvedInputs } from '#input/types';
import type { HarnessPluginActions } from '#integrations/native/plugin-actions';
import type { TailnetExitNode } from '#integrations/tailscale';

import type { CreatePreflight } from './context.js';

import type { CreatePreparation } from './preparation.js';

interface RequiredCreateValues {
  name: string;
  token: string;
}

interface ReviewContext {
  values: RequiredCreateValues;
  input: ResolvedInputs;
  plugins: HarnessPluginActions;
  verifiedExitNode?: TailnetExitNode;
  interaction?: Interaction;
  preflight: CreatePreflight;
}

interface CreateProviderChecks {
  collision: boolean;
  verifiedExitNode?: TailnetExitNode;
  issues: CommandError[];
}

interface ConfirmationContext {
  name: string;
  request: CommandRequest;
  plugins: HarnessPluginActions;
}

interface CreateAuthorizationContext extends ReviewContext {
  request: CommandRequest;
  client: SpritesClient;
}

export type { CreatePreparation } from './preparation.js';

/**
 * resolve, verify, and confirm all deterministic inputs before Sprite creation
 * @param request parsed create command and explicit selections
 * @param interaction optional inline review and consent prompts
 * @returns complete provisioning context or a preflight/cancel result
 */
export async function prepareCreate(
  request: CommandRequest,
  interaction?: Interaction,
): Promise<CreatePreparation> {
  const input = await resolveCreateInputs(request.options, interaction);
  if (input.missing.length > 0) {
    return result('INPUT', 'Required provisioning inputs are missing', {
      details: missingCreateDetails(input.missing),
    });
  }
  const values = requireCreateValues(input);
  validateMachineName(values.name);
  const pluginOptions = await promptCreatePluginOptions(
    request.options,
    interaction,
  );
  const plugins = resolvePluginActions(pluginOptions);
  const marketplaceToken =
    request.options.githubHost &&
    request.options.githubHost.toLowerCase() !== 'github.com'
      ? undefined
      : input.githubToken;
  await validateMarketplaceSources(plugins, marketplaceToken, true);
  const client = createSpritesClient(values.token);
  const names = await checkProviderAndTailnet(client, values, input);
  if (names.issues.length > 0) {
    return result(
      names.issues[0]!.code,
      'Provider preflight checks failed; no Sprite was created',
      {
        details: names.issues.map((issue) => issue.message),
      },
    );
  }
  if (names.collision) {
    return result('CONFLICT', `Sprite ${values.name} already exists`, {
      machine: values.name,
    });
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
    client,
  }).catch((error: unknown) => {
    checkOperation();

    return authorizationFailure(error);
  });
}

/**
 * preserves required-input guidance and the actual implicit prompt blocker
 * @param missing required inputs unresolved before provider work
 * @returns safe details for the typed INPUT failure
 */
function missingCreateDetails(missing: string[]): string[] {
  const promptHint = promptUnavailableDetail();

  return [
    ...missing,
    ...(missing.includes('SPRITES_TOKEN') ? spritesTokenGuidance : []),
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
    client,
  } = context;
  reviewCreatePlan(context);
  const declined = await confirmCreation(
    { name: values.name, request, plugins },
    interaction,
  );
  if (declined) {
    return result('CANCELLED', declined);
  }
  const authKey = input.integrations.tailscale
    ? await resolveEnrollmentKey(input)
    : undefined;

  return {
    kind: 'ready',
    context: {
      options: request.options,
      input,
      name: values.name,
      token: values.token,
      integrations: input.integrations,
      effectiveExitNode: input.integrations.exitNode
        ? (verifiedExitNode?.ip ?? input.exitNode)
        : undefined,
      authKey,
      plugins,
      preflight,
      client,
    },
  };
}

/**
 * checks the provider name and exact tailnet hostname before creating a Sprite
 * @param client authenticated Sprite client
 * @param values required create inputs
 * @param input caller-side Tailscale management credential, if available
 * @returns collision status, verified exit-node identity, and all failed checks
 */
async function checkProviderAndTailnet(
  client: SpritesClient,
  values: RequiredCreateValues,
  input: ResolvedInputs,
): Promise<CreateProviderChecks> {
  const [provider, exit, hostname] = await runOperation(async () =>
    Promise.allSettled([
      runOperation(async () => client.listAllSprites()),
      input.integrations.exitNode && input.tailscaleApiKey && input.tailnet
        ? resolveExitNode(input.tailscaleApiKey, input.tailnet, input.exitNode!)
        : Promise.resolve(undefined),
      input.integrations.tailscale && input.tailscaleApiKey && input.tailnet
        ? assertTailnetHostnameAvailable(
            input.tailscaleApiKey,
            input.tailnet,
            values.name,
          )
        : Promise.resolve(),
    ]),
  );

  return {
    collision:
      provider.status === 'fulfilled' &&
      provider.value.some((sprite) => sprite.name === values.name),
    verifiedExitNode: exit.status === 'fulfilled' ? exit.value : undefined,
    issues: [provider, exit, hostname].flatMap((check) => {
      if (check.status !== 'rejected') {
        return [];
      }
      const failure = commandError(check.reason);

      return [failure];
    }),
  };
}

/**
 * narrows mandatory values after the aggregate missing-input check
 * @param input resolved create input values
 * @returns values required to create one workstation
 */
function requireCreateValues(input: ResolvedInputs): RequiredCreateValues {
  const { name, spritesToken: token } = input;
  if (!name || !token) {
    throw new Error('Validated create inputs were unavailable');
  }

  return { name, token };
}

/**
 * presents non-secret values and native code selections for review
 * @param context required create values and optional status reporter
 */
function reviewCreatePlan(context: ReviewContext): void {
  const { values, input, plugins, verifiedExitNode, interaction, preflight } =
    context;
  const exitNode = verifiedExitNode?.name ?? input.exitNode;
  const tailscale = input.integrations.tailscale
    ? input.integrations.exitNode
      ? `Tailscale enabled, exit node ${exitNode}`
      : 'Tailscale enabled, direct routing'
    : 'Tailscale disabled';
  publishStatus(
    {
      kind: 'info',
      message: [
        `Create ${values.name} in the current Fly organization`,
        tailscale,
        input.integrations.cliproxyapi
          ? `CLIProxyAPI ${input.proxyUrl}`
          : 'CLIProxyAPI disabled',
        'T3 exposed after readiness',
        `Sprites credential: ${input.sources.SPRITES_TOKEN ?? 'prompt/session'}`,
        `Tailscale credential: ${input.sources.TAILSCALE_API_KEY ?? (input.tailscaleAuthKey ? 'auth key' : 'prompt/session')}`,
        `GitHub: ${input.githubToken ? 'selected' : 'skipped'}; Git identity: ${input.gitIdentity ? 'configured' : 'skipped'}`,
        `Claude marketplaces: ${describeSelections(plugins.claude.marketplaces)}; plugins: ${describeSelections(plugins.claude.plugins)}`,
        `Codex marketplaces: ${describeSelections(plugins.codex.marketplaces)}; plugins: ${describeSelections(plugins.codex.plugins)}`,
      ].join('\n'),
    },
    interaction,
  );
  for (const message of preflight.reminders) {
    publishStatus({ kind: 'warning', message }, interaction);
  }
}

/**
 * describes an optional list without treating an empty list as a selection
 * @param choices native sources or plugin identities
 * @returns a compact review label
 */
function describeSelections(choices: string[]): string {
  return choices.length ? choices.join(', ') : 'none';
}

/**
 * confirms selected native code and provider provisioning separately
 * @param context exact name, parsed consent flags, and selected code
 * @param interaction optional confirmation prompts
 * @returns cancellation reason when a confirmation was declined
 */
async function confirmCreation(
  context: ConfirmationContext,
  interaction?: Interaction,
): Promise<string | undefined> {
  const { name, request, plugins } = context;
  if (
    interaction &&
    !request.options.yes &&
    (hasActions(plugins.claude) || hasActions(plugins.codex))
  ) {
    const trusted = await interaction.confirm({
      message:
        'Install the selected native marketplace/plugin code, including executable hooks?',
    });
    if (!trusted) {
      return 'Plugin selection was not accepted; no Sprite was created';
    }
  }
  if (interaction && !request.options.nonInteractive && !request.options.yes) {
    const accepted = await interaction.confirm({
      message: `Create ${name} in the current Fly organization and expose authenticated T3 at its provider URL?`,
    });
    if (!accepted) {
      return 'Create was cancelled before provisioning';
    }
  }

  return undefined;
}

/**
 * selects a provided auth key or mint a short-lived single-use key
 * @param input resolved caller-side Tailscale credentials
 * @returns transient key for one new device
 */
async function resolveEnrollmentKey(input: ResolvedInputs): Promise<string> {
  const authKey =
    input.tailscaleAuthKey ??
    (input.tailscaleApiKey && input.tailnet
      ? await createTailscaleAuthKey(input.tailscaleApiKey, input.tailnet)
      : undefined);
  if (!authKey) {
    throw new CommandFault({
      code: 'INPUT',
      message: 'Tailscale enrolment requires an auth key or management API key',
    });
  }

  return authKey;
}

/**
 * returns a structured preflight outcome before any Sprite exists
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
