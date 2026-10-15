import { requireValidSuppliedSelection } from '#input';
import { readSetupSelection } from '#input/selection';
import { readInputSources } from '#input/sources';
import { selectManagedMachine } from '#inspect';
import { summarizeMachine } from '#machine';
import { InteractionExit, returnOnBack, withBackNavigation } from '#navigation';
import { traceStage } from '#operation';

import { validateSetupIntegrationOptions } from '#validation';

import { setupAll } from './setup/all.js';
import { setupLocalCredential } from './setup/credentials.js';
import { setupFailure } from './setup/failure.js';
import { recordSetupMetadata } from './setup/metadata.js';
import { setupNetwork } from './setup/network.js';
import { setupPlugins } from './setup/plugins.js';
import { prepareSetupContext } from './setup/prepare.js';
import {
  setupEnvironment,
  setupGit,
  setupGithub,
  setupAgent,
  setupProxy,
  setupTools,
} from './setup/sections.js';
import { selectSetupSection } from './setup/selection.js';

import type { CommandResult } from '#command';
import type {
  CommandOptions,
  CommandRequest,
  Interaction,
  SetupSection,
} from '#command/contracts';
import type { AppliedSetupSection } from '#command/data';
import type { ProviderDriver, WorkstationRecord } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';
import type { SuppliedSelection } from '#input/selection';
import type { InputSources } from '#input/sources';

import type { SetupContext } from './setup/context.js';
import type { SetupSelection } from './setup/selection.js';

interface SetupSelectionParams {
  request: CommandRequest;
  section: SetupSelection;
  provider: ProviderDriver;
  interaction?: Interaction;
}

/**
 * applies only the requested setup section to one live managed machine
 * @param request parsed setup request and target name
 * @param provider authenticated provider driver
 * @param interaction optional inline prompts
 * @returns the section outcome and current control-plane summary
 */
export async function setupWorkstation(
  request: CommandRequest,
  provider: ProviderDriver,
  interaction?: Interaction,
): Promise<CommandResult> {
  let currentRequest = request;
  for (;;) {
    const section = await selectSetupSection(
      currentRequest.options,
      interaction,
    );
    const result = await returnOnBack(async () =>
      setupSelection({
        request: currentRequest,
        section,
        provider,
        interaction,
      }),
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
 * @param params request, selected section, provider driver and active prompts
 * @param params.section selected guest or local task
 * @param params.interaction optional active prompts
 * @returns section result
 */
async function setupSelection(
  params: SetupSelectionParams,
): Promise<CommandResult> {
  const { request, section, provider, interaction } = params;
  const nested = interaction
    ? withBackNavigation(interaction, 'back to sections')
    : interaction;
  if (section === 'network-credential') {
    return setupLocalCredential(nested, request.options);
  }
  const { sources, supplied } = await readStaticSetupInputs(
    request.options,
    section,
  );
  const workstation = await selectManagedMachine(
    provider,
    request.machine,
    nested,
  );
  const opened = await provider.openGuest(workstation);
  const mutation = { started: false };
  try {
    const { context, guest } = await traceStage('setup.preparation', async () =>
      prepareSetupContext({
        provider,
        supplied,
        sources,
        workstation,
        guest: opened,
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
    const result = await applySection(guest, section, context);

    return setupSuccess(
      await recordSetupMetadata(section, context),
      result,
      context,
    );
  } catch (error) {
    if (
      error instanceof InteractionExit &&
      error.action === 'back' &&
      !mutation.started
    ) {
      throw error;
    }

    return setupFailure({ provider, workstation, error, mutation, section });
  }
}

/**
 * reads and validates every static setup input before any provider or guest
 * call: integration flags, catalog ids, option bounds and determined capabilities
 * @param options parsed setup flags
 * @param section targeted setup area
 * @returns the input sources and the validated supplied values
 */
async function readStaticSetupInputs(
  options: CommandOptions,
  section: SetupSection,
): Promise<{ sources: InputSources; supplied: SuppliedSelection }> {
  validateSetupIntegrationOptions(options, section);
  const sources = await readInputSources(options);
  const supplied = readSetupSelection({ options, sources, section });
  requireValidSuppliedSelection(supplied, options);

  return { sources, supplied: supplied.value };
}

/**
 * reports a completed section with the current control-plane summary
 * @param workstation workstation as labelled after the section
 * @param result non-secret section outcome
 * @param context setup inputs carrying retained credential outcomes
 * @returns successful setup result
 */
function setupSuccess(
  workstation: WorkstationRecord,
  result: AppliedSetupSection,
  context: SetupContext,
): CommandResult {
  return {
    command: 'setup',
    ok: true,
    data: {
      machine: summarizeMachine(
        workstation,
        'pairing' in result ? result.pairing?.token : undefined,
      ),
      retainedCredentials: context.input.retainedCredentials,
      ...result,
    },
  };
}

/**
 * applies one selected section without changing unrelated sections
 * @param guest guest channel of the managed workstation
 * @param section area selected for setup
 * @param context parsed options, prompts, and redaction values
 * @returns non-secret section outcome
 */
async function applySection(
  guest: GuestChannel,
  section: SetupSection,
  context: SetupContext,
): Promise<AppliedSetupSection> {
  return traceStage(`setup.${section}`, async () => {
    switch (section) {
      case 'agent':
        return { section, ...(await setupAgent(guest, context)) };
      case 'network':
        return { section, ...(await setupNetwork(guest, context)) };
      case 'github':
        return { section, ...(await setupGithub(guest, context)) };
      case 'git':
        return { section, ...(await setupGit(guest, context)) };
      case 'proxy':
        return { section, ...(await setupProxy(guest, context)) };
      case 'env':
        return { section, ...(await setupEnvironment(guest, context)) };
      case 'plugins':
        return { section, ...(await setupPlugins(guest, context)) };
      case 'tools':
        return { section, ...(await setupTools(guest, context)) };
      case 'all':
        return { section, ...(await setupAll(guest, context)) };
      default:
        throw new Error(`Unsupported setup section: ${section}`);
    }
  });
}
