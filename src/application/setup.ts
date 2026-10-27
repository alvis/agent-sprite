import { requireValidSuppliedSelection } from '#application/input';
import { readSetupSelection } from '#application/input/selection';
import { readInputSources } from '#application/input/sources';
import { selectManagedMachine } from '#application/inspect';
import { summarizeMachine } from '#application/machine';
import { withBackNavigation } from '#application/navigation';
import { validateSetupIntegrationOptions } from '#application/validation';
import { InteractionExit, returnOnBack } from '#kernel/navigation';
import { traceStage } from '#kernel/operation';

import { setupAll } from './setup/all';
import { setupLocalCredential } from './setup/credentials';
import { setupFailure } from './setup/failure';
import { recordSetupMetadata } from './setup/metadata';
import { setupNetwork } from './setup/network';
import { setupPlugins } from './setup/plugins';
import { prepareSetupContext } from './setup/prepare';
import {
  setupEnvironment,
  setupGit,
  setupGithub,
  setupAgent,
  setupProxy,
  setupSystem,
} from './setup/sections';
import { selectSetupSection } from './setup/selection';
import { setupTools } from './setup/tools';

import type {
  CommandOptions,
  CommandRequest,
  SetupSection,
  WorkstationCommandParams,
} from '#application/contracts';
import type { AppliedSetupSection } from '#application/data';
import type { SuppliedSelection } from '#application/input/selection-supplied';
import type { InputSources } from '#application/input/sources';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { ProviderDriver } from '#application/ports/drivers';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { Interaction } from '#application/ports/interaction';
import type { CommandResult } from '#application/result';
import type { WorkstationRecord } from '#domain/workstation';

import type { SetupContext } from './setup/context';
import type { SetupSelection } from './setup/selection';

interface SetupSelectionParams {
  request: CommandRequest;
  section: SetupSelection;
  provider: ProviderDriver;
  interaction?: Interaction;
}

/** a guest section to apply to a selected workstation */
interface GuestSectionParams extends Omit<SetupSelectionParams, 'section'> {
  section: Exclude<SetupSelection, 'network-credential'>;
  /** the selected, supported workstation */
  workstation: WorkstationRecord;
  /** where interactive values are read from */
  sources: InputSources;
  /** the validated supplied values */
  supplied: SuppliedSelection;
}

/**
 * applies only the requested setup section to one live managed machine
 * @param dependencies the registered drivers, the profile defaults, the guest mechanics, what this computer provides
 * @param params the call's inputs: request, provider, interaction
 * @returns the section outcome and current control-plane summary
 */
export async function setupWorkstation(
  dependencies: ApplicationDependencies,
  params: WorkstationCommandParams,
): Promise<CommandResult> {
  const { request, provider, interaction } = params;
  let currentRequest = request;
  for (;;) {
    const section = await selectSetupSection(
      currentRequest.options,
      interaction,
    );
    const result = await returnOnBack(async () =>
      setupSelection(dependencies, {
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
 * @param dependencies the registered drivers, the profile defaults, the guest mechanics, what this computer provides
 * @param params request, selected section, provider driver and active prompts
 * @param params.section selected guest or local task
 * @param params.interaction optional active prompts
 * @returns section result
 */
async function setupSelection(
  dependencies: ApplicationDependencies,
  params: SetupSelectionParams,
): Promise<CommandResult> {
  const { request, section, provider, interaction } = params;
  const nested = interaction
    ? withBackNavigation(interaction, 'back to sections')
    : interaction;
  if (section === 'network-credential') {
    return setupLocalCredential(dependencies, {
      interaction: nested,
      options: request.options,
    });
  }
  const { sources, supplied } = await readStaticSetupInputs(
    dependencies,
    request.options,
    section,
  );
  const workstation = await selectManagedMachine(dependencies, {
    provider,
    requestedName: request.machine,
    interaction: nested,
    release: 'guest',
  });

  return setupGuestSection(dependencies, {
    request,
    section,
    provider,
    interaction: nested,
    workstation,
    sources,
    supplied,
  });
}

/**
 * applies a guest section to the selected workstation over one root setup
 * session that every guest command of the run, the setup plan's included,
 * shares
 * @param dependencies the registered drivers, the profile defaults, the guest mechanics, what this computer provides
 * @param params request, section, provider, prompts, workstation and validated inputs
 * @returns section result
 */
async function setupGuestSection(
  dependencies: ApplicationDependencies,
  params: GuestSectionParams,
): Promise<CommandResult> {
  const { section, provider, workstation, interaction: nested } = params;
  const connection = dependencies.guest.session.connect({
    provider,
    workstation,
  });
  const mutation = { started: false };
  let current = connection;
  try {
    const { context, guest } = await prepareGuestSection(dependencies, {
      provider,
      supplied: params.supplied,
      sources: params.sources,
      workstation,
      connection,
      section,
      options: params.request.options,
      interaction: params.interaction,
      mutation,
    });
    current = context.connection;
    if (nested && (section === 'all' || mutation.started)) {
      context.interaction = withBackNavigation(
        nested,
        'stop setup (changes may already be applied)',
      );
    }
    const result = await applySection(dependencies, {
      guest,
      section,
      context,
    });

    return setupSuccess(dependencies, {
      workstation: await recordSetupMetadata(section, context),
      result,
      context,
    });
  } catch (error) {
    if (
      error instanceof InteractionExit &&
      error.action === 'back' &&
      !mutation.started
    ) {
      throw error;
    }

    return await setupFailure({
      provider,
      workstation,
      error,
      mutation,
      section,
    });
  } finally {
    await current.close();
    await connection.close();
  }
}
/** setup inputs before a guest channel exists */
type GuestPreparationParams = Omit<
  Parameters<typeof prepareSetupContext>[1],
  'guest'
>;

/**
 * opens the root guest channel and prepares the requested setup section
 * @param dependencies application facilities
 * @param params section inputs before a guest channel exists
 * @returns prepared setup context and guest channel
 */
export async function prepareGuestSection(
  dependencies: ApplicationDependencies,
  params: GuestPreparationParams,
): ReturnType<typeof prepareSetupContext> {
  return traceStage('setup.preparation', async () =>
    prepareSetupContext(dependencies, {
      ...params,
      guest: await params.connection.guest(),
    }),
  );
}

/**
 * reads and validates every static setup input before any provider or guest
 * call: integration flags, catalog ids, option bounds and determined capabilities
 * @param dependencies the registered drivers, the profile defaults, what this computer provides
 * @param options parsed setup flags
 * @param section targeted setup area
 * @returns the input sources and the validated supplied values
 */
async function readStaticSetupInputs(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'defaults' | 'host'>,
  options: CommandOptions,
  section: SetupSection,
): Promise<{ sources: InputSources; supplied: SuppliedSelection }> {
  validateSetupIntegrationOptions(options, section);
  const sources = await readInputSources(dependencies, options);
  const supplied = readSetupSelection(dependencies, {
    options,
    sources,
    section,
  });
  requireValidSuppliedSelection(dependencies, supplied, options);

  return { sources, supplied: supplied.value };
}

/** the named inputs of setup success */
interface SetupSuccessParams {
  /** workstation as labelled after the section */
  workstation: WorkstationRecord;
  /** non-secret section outcome */
  result: AppliedSetupSection;
  /** setup inputs carrying retained credential outcomes */
  context: SetupContext;
}

/**
 * reports a completed section with the current control-plane summary
 * @param dependencies the registered drivers
 * @param params the call's inputs: workstation, result, context
 * @returns successful setup result
 */
function setupSuccess(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  params: SetupSuccessParams,
): CommandResult {
  const { workstation, result, context } = params;

  return {
    command: 'setup',
    ok: true,
    data: {
      machine: summarizeMachine(
        dependencies,
        workstation,
        'pairing' in result ? result.pairing?.token : undefined,
      ),
      retainedCredentials: context.input.retainedCredentials,
      ...result,
    },
  };
}

/** the named inputs of apply section */
interface ApplySectionParams {
  /** guest channel of the managed workstation */
  guest: GuestChannel;
  /** area selected for setup */
  section: SetupSection;
  /** parsed options, prompts, and redaction values */
  context: SetupContext;
}

/**
 * applies one selected section without changing unrelated sections
 * @param dependencies the registered drivers, the profile defaults, the guest mechanics, what this computer provides
 * @param params the call's inputs: guest, section, context
 * @returns non-secret section outcome
 */
async function applySection(
  dependencies: ApplicationDependencies,
  params: ApplySectionParams,
): Promise<AppliedSetupSection> {
  const { guest, section, context } = params;
  const actions = {
    agent: async (): Promise<AppliedSetupSection> => ({
      section: 'agent',
      ...(await setupAgent(dependencies, guest, context)),
    }),
    network: async (): Promise<AppliedSetupSection> => ({
      section: 'network',
      ...(await setupNetwork(dependencies, guest, context)),
    }),
    github: async (): Promise<AppliedSetupSection> => ({
      section: 'github',
      ...(await setupGithub(dependencies, guest, context)),
    }),
    git: async (): Promise<AppliedSetupSection> => ({
      section: 'git',
      ...(await setupGit(dependencies, guest, context)),
    }),
    proxy: async (): Promise<AppliedSetupSection> => ({
      section: 'proxy',
      ...(await setupProxy(dependencies, guest, context)),
    }),
    env: async (): Promise<AppliedSetupSection> => ({
      section: 'env',
      ...(await setupEnvironment(dependencies, guest, context)),
    }),
    system: async (): Promise<AppliedSetupSection> => ({
      section: 'system',
      ...(await setupSystem(dependencies, guest, context)),
    }),
    plugins: async (): Promise<AppliedSetupSection> => ({
      section: 'plugins',
      ...(await setupPlugins(dependencies, guest, context)),
    }),
    tools: async (): Promise<AppliedSetupSection> => ({
      section: 'tools',
      ...(await setupTools(dependencies, guest, context)),
    }),
    all: async (): Promise<AppliedSetupSection> => ({
      section: 'all',
      ...(await setupAll(dependencies, guest, context)),
    }),
  } satisfies Record<SetupSection, () => Promise<AppliedSetupSection>>;

  return traceStage(`setup.${section}`, actions[section]);
}
