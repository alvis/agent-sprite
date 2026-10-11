import { CommandFault } from '#errors';

import { resolveInputs } from '#input';
import {
  integrationRequirements,
  resolveSetupIntegrations,
} from '#input/integrations';
import { selectManagedMachine } from '#inspect';
import { guestFileExists } from '#integrations/guest';
import {
  inspectTailscale,
  readGuestManifest,
} from '#integrations/guest/runtime';
import {
  setManagedSpriteLabels,
  SETUP_READY_LABEL,
} from '#integrations/sprites';
import { summarizeMachine } from '#machine';
import { InteractionExit, returnOnBack, withBackNavigation } from '#navigation';
import { promptUnavailableDetail, traceStage } from '#operation';

import { validateSetupIntegrationOptions } from '#validation';

import { setupAll } from './setup/all.js';
import { setupLocalCredential } from './setup/credentials.js';
import { setupFailure } from './setup/failure.js';
import { persistSetupIntegrations } from './setup/integrations.js';
import { setupPlugins } from './setup/plugins.js';
import {
  setupEnvironment,
  setupGit,
  setupGithub,
  setupProxy,
  setupT3,
  setupTools,
} from './setup/sections.js';
import { selectSetupSection } from './setup/selection.js';

import { setupTailscale, verifySetupExitNode } from './setup/tailscale.js';

import type { SpritesClient, Sprite } from '@fly/sprites';

import type { CommandResult } from '#command';
import type {
  CommandOptions,
  CommandRequest,
  Interaction,
  SetupSection,
} from '#command/contracts';
import type { AppliedSetupSection } from '#command/data';
import type { GuestManifest } from '#integrations/guest/types';

import type { SetupContext, SetupProgress } from './setup/context.js';
import type { SetupSelection } from './setup/selection.js';

interface SetupPreparationParams {
  sprite: Sprite;
  section: SetupSection;
  options: CommandOptions;
  interaction?: Interaction;
  mutation: SetupProgress;
}

interface SetupSelectionParams {
  request: CommandRequest;
  section: SetupSelection;
  client: SpritesClient;
  interaction?: Interaction;
}

/**
 * applies only the requested setup section to one live managed machine
 * @param request parsed setup request and target name
 * @param client authenticated provider client
 * @param interaction optional inline prompts
 * @returns the section outcome and current control-plane summary
 */
export async function setupWorkstation(
  request: CommandRequest,
  client: SpritesClient,
  interaction?: Interaction,
): Promise<CommandResult> {
  let currentRequest = request;
  for (;;) {
    const section = await selectSetupSection(
      currentRequest.options,
      interaction,
    );
    const result = await returnOnBack(async () =>
      setupSelection({ request: currentRequest, section, client, interaction }),
    );
    if (result) {
      return result;
    }
    currentRequest = {
      ...request,
      options: { ...request.options, section: undefined },
    };
  }
}

/**
 * applies one section while retaining mutation-aware cancellation
 * @param params request, selected section, provider client and active prompts
 * @param params.section selected guest or local task
 * @param params.interaction optional active prompts
 * @returns section result
 */
async function setupSelection(
  params: SetupSelectionParams,
): Promise<CommandResult> {
  const { request, section, client, interaction } = params;
  const nested = interaction
    ? withBackNavigation(interaction, 'back to sections')
    : interaction;
  if (section === 'tailscale-credential') {
    return setupLocalCredential(nested, request.options);
  }
  validateSetupIntegrationOptions(request.options, section);
  const sprite = await selectManagedMachine(client, request.machine, nested);
  const mutation = { started: false };
  try {
    const context = await traceStage('setup.preparation', async () =>
      prepareSetupContext({
        sprite,
        section,
        options: request.options,
        interaction: nested,
        mutation,
      }),
    );
    if (nested && (section === 'all' || mutation.started)) {
      context.interaction = withBackNavigation(
        nested,
        'stop setup (changes may already be applied)',
      );
    }
    const result = await applySection(sprite, section, context);
    const updated =
      section === 'all'
        ? await setManagedSpriteLabels(sprite, [SETUP_READY_LABEL])
        : sprite;

    return {
      command: 'setup',
      ok: true,
      data: {
        machine: summarizeMachine(
          updated,
          'pairing' in result ? result.pairing?.token : undefined,
        ),
        retainedCredentials: context.input.retainedCredentials,
        ...result,
      },
    };
  } catch (error) {
    if (
      error instanceof InteractionExit &&
      error.action === 'back' &&
      !mutation.started
    ) {
      throw error;
    }

    return setupFailure({ sprite, error, mutation, section });
  }
}

/**
 * resolves and persists setup integration choices before section mutations
 * @param params target, selected section, input choices, and diagnostic state
 * @returns complete setup context for the selected section
 */
async function prepareSetupContext(
  params: SetupPreparationParams,
): Promise<SetupContext> {
  const { sprite, section, options, interaction, mutation } = params;
  const manifest = await readSetupManifest(sprite, section);
  const hasManifest = manifest !== undefined;
  const installed = manifest?.integrations ?? {
    tailscale: hasManifest,
    exitNode: hasManifest,
    cliproxyapi: hasManifest,
  };
  const integrations = await resolveSetupIntegrations({
    options,
    interaction,
    installed,
    selectedSection:
      section === 'all' || section === 'tailscale' || section === 'proxy'
        ? section
        : undefined,
  });
  const updatesIntegrations = integrationUpdateSelected(section, options);
  const requiredIntegrations = requiredSetupIntegrations(
    section,
    options,
    integrations,
  );
  const enrolled =
    Boolean(manifest?.tailnetIdentity?.deviceId) ||
    (hasManifest && requiredIntegrations.tailscale && installed.tailscale
      ? Boolean((await inspectTailscale(sprite)).deviceId)
      : false);
  const input = await resolveInputs(options, interaction, {
    required: updatesIntegrations
      ? integrationRequirements(requiredIntegrations, [], enrolled)
      : [],
    integrations,
  });
  if (input.missing.length > 0) {
    throw new CommandFault({
      code: 'INPUT',
      message: missingSetupMessage(input.missing),
    });
  }
  const exitNode = await verifySetupExitNode(input, requiredIntegrations);
  if (updatesIntegrations && hasManifest) {
    const persistence = { mutation, expected: installed };
    await persistSetupIntegrations(sprite, integrations, persistence);
  }

  return {
    options,
    interaction,
    input,
    integrations,
    tailscaleEnrolled: enrolled,
    verifiedExitNode: exitNode,
    initialInstallation:
      !manifest || !sprite.labels.includes(SETUP_READY_LABEL),
    mutation,
  };
}

/**
 * adds terminal guidance only when an implicit blocker hid a required prompt
 * @param missing unresolved setup inputs
 * @returns actionable INPUT message
 */
function missingSetupMessage(missing: string[]): string {
  return [`Missing: ${missing.join(', ')}`, promptUnavailableDetail()]
    .filter(Boolean)
    .join('. ');
}

/**
 * detects whether this setup invocation changes persisted integration choices
 * @param section selected setup area
 * @param options parsed tri-state choices
 * @returns whether integration persistence is required
 */
function integrationUpdateSelected(
  section: SetupSection,
  options: CommandOptions,
): boolean {
  return (
    section === 'all' ||
    section === 'tailscale' ||
    section === 'proxy' ||
    options.tailscale !== undefined ||
    options.proxy !== undefined ||
    options.useExitNode !== undefined
  );
}
/**
 * limits preflight credentials to integrations targeted by this setup run
 * @param section selected setup area
 * @param options parsed tri-state choices
 * @param integrations effective persisted selections
 * @returns integration subset whose credentials must be present
 */
function requiredSetupIntegrations(
  section: SetupSection,
  options: CommandOptions,
  integrations: SetupContext['integrations'],
): SetupContext['integrations'] {
  return {
    tailscale:
      integrations.tailscale &&
      (section === 'all' ||
        section === 'tailscale' ||
        options.tailscale !== undefined ||
        options.useExitNode !== undefined),
    exitNode:
      integrations.exitNode &&
      (section === 'all' ||
        section === 'tailscale' ||
        options.useExitNode !== undefined),
    cliproxyapi:
      integrations.cliproxyapi &&
      (section === 'all' || section === 'proxy' || options.proxy !== undefined),
  };
}

/**
 * applies one selected section without changing unrelated sections
 * @param sprite exact managed Sprite
 * @param section area selected for setup
 * @param context parsed options, prompts, and redaction values
 * @returns non-secret section outcome
 */
async function applySection(
  sprite: Sprite,
  section: SetupSection,
  context: SetupContext,
): Promise<AppliedSetupSection> {
  return traceStage(`setup.${section}`, async () => {
    switch (section) {
      case 't3':
        return { section, ...(await setupT3(sprite, context)) };
      case 'tailscale':
        return { section, ...(await setupTailscale(sprite, context)) };
      case 'github':
        return { section, ...(await setupGithub(sprite, context)) };
      case 'git':
        return { section, ...(await setupGit(sprite, context)) };
      case 'proxy':
        return { section, ...(await setupProxy(sprite, context)) };
      case 'env':
        return { section, ...(await setupEnvironment(sprite, context)) };
      case 'plugins':
        return { section, ...(await setupPlugins(sprite, context)) };
      case 'tools':
        return { section, ...(await setupTools(sprite, context)) };
      case 'all':
        return { section, ...(await setupAll(sprite, context)) };
      default:
        throw new Error(`Unsupported setup section: ${section}`);
    }
  });
}

/**
 * requires full recovery when initial installation has no manifest
 * @param sprite selected managed guest
 * @param section requested setup scope
 * @returns persisted manifest, or undefined for initial full recovery
 */
async function readSetupManifest(
  sprite: Sprite,
  section: SetupSection,
): Promise<GuestManifest | undefined> {
  if (await guestFileExists(sprite, '/opt/agent-sprite/manifest.json')) {
    return readGuestManifest(sprite);
  }
  if (section !== 'all') {
    throw new CommandFault({
      code: 'PREFLIGHT',
      message:
        'Initial installation is incomplete; recover with setup --section all',
    });
  }

  return undefined;
}
