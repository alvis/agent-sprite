import { requireValidProfile, resolveInputs } from '#application/input';
import {
  resolveSetupSelection,
  selectionRequirements,
} from '#application/input/selection';
import { CommandFault } from '#kernel/faults';
import { promptUnavailableDetail, traceStage } from '#kernel/operation';

import {
  persistSetupProfile,
  profileUpdateSelected,
  targetedProfile,
} from './integrations';
import { verifySetupExitNode } from './network';
import {
  assertSameWorkstationKind,
  isNetworkEnrolled,
  readSetupEnvironment,
  unrecordedProfile,
} from './recorded';
import { isAgentReleaseChanged } from './release';
import { resizeWhenRequested } from './resize';

import type { CommandOptions, SetupSection } from '#application/contracts';
import type { SuppliedSelection } from '#application/input/selection/supplied';
import type { InputSources } from '#application/input/sources';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { ProviderDriver } from '#application/ports/drivers';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { Interaction } from '#application/ports/interaction';
import type { SetupSession } from '#application/ports/session';
import type { WorkstationProfile } from '#domain/profile';
import type { WorkstationRecord } from '#domain/workstation';

import type { SetupContext, SetupProgress } from './context';

/** what a setup run is prepared from */
interface SetupPreparationParams {
  /** authenticated provider driver */
  provider: ProviderDriver;
  /** values the run's flags and section-scoped environment supply, already validated */
  supplied: SuppliedSelection;
  /** sources the supplied values were read from */
  sources: InputSources;
  /** machine the section is applied to */
  workstation: WorkstationRecord;
  /** the root setup session opened to the machine */
  connection: SetupSession;
  /** channel over that session */
  guest: GuestChannel;
  /** targeted setup area */
  section: SetupSection;
  /** parsed setup flags */
  options: CommandOptions;
  /** active prompts, when the run is interactive */
  interaction?: Interaction;
  /** diagnostic state shared with failure reporting */
  mutation: SetupProgress;
}

/** a setup run ready to apply its section */
interface PreparedSetup {
  /** complete setup context for the selected section */
  context: SetupContext;
  /** guest channel to apply the section through; over a new session when a resize restarted the machine */
  guest: GuestChannel;
}

/** setup inputs before a guest channel exists */
type GuestPreparationParams = Omit<
  Parameters<typeof prepareSetupContext>[1],
  'guest'
>;

/** what a prepared setup context is assembled from */
interface SetupContextParts {
  /** the recorded state, validated profile and resolved inputs */
  resolved: ResolvedSetup;
  /** the machine as resized */
  resized: WorkstationRecord;
  /** the session the section applies over */
  connection: SetupSession;
  /** the exit node the network section verified, if any */
  verifiedExitNode: SetupContext['verifiedExitNode'];
}

/** the named inputs of reconnect */
interface ReconnectParams {
  /** the session that ran on the machine before it restarted */
  lost: SetupSession;
  /** the provider that opens the new session */
  provider: ProviderDriver;
  /** the machine as resized */
  resized: WorkstationRecord;
}

/** the recorded state of a machine and the setup selection resolved against it */
interface ResolvedSetup {
  /** what the machine records, when it records anything */
  environment: Awaited<ReturnType<typeof readSetupEnvironment>>;
  /** the profile the machine records */
  recorded: WorkstationProfile;
  /** the validated profile this run applies */
  profile: WorkstationProfile;
  /** whether the run writes the profile back */
  persistsProfile: boolean;
  /** the part of the profile the section targets */
  targeted: ReturnType<typeof targetedProfile>;
  /** whether the selected network is already enrolled */
  networkEnrolled: boolean;
  /** whether this run moves the agent's installed release */
  isReleaseChanged: boolean;
  /** the inputs the run needs, resolved */
  input: Awaited<ReturnType<typeof resolveInputs>>;
}

/** the named inputs of resolveSetupInputs */
interface SetupInputsParams {
  /** target, selected section and input choices */
  setup: SetupPreparationParams;
  /** the validated profile this run applies */
  profile: WorkstationProfile;
  /** whether the run writes the profile back, what the section targets and whether the network is enrolled */
  state: Pick<
    ResolvedSetup,
    'persistsProfile' | 'targeted' | 'networkEnrolled'
  >;
}

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
  return traceStage({
    stage: 'setup.preparation',
    action: async () =>
      prepareSetupContext(dependencies, {
        ...params,
        guest: await params.connection.guest(),
      }),
  });
}

/**
 * resolves, validates and persists the setup selection before section mutations
 * @param dependencies the registered drivers, the profile defaults, the guest mechanics, what this computer provides
 * @param params target, selected section, input choices, and diagnostic state
 * @returns complete setup context for the selected section and the channel to apply it through
 */
export async function prepareSetupContext(
  dependencies: ApplicationDependencies,
  params: SetupPreparationParams,
): Promise<PreparedSetup> {
  const { provider, workstation, section, options, interaction } = params;
  const resolved = await resolveSetup(dependencies, params);
  const { profile, input, targeted } = resolved;
  const exitNode = await verifySetupExitNode(dependencies, input, targeted);
  const resized = await resizeWhenRequested({
    provider,
    workstation,
    profile,
    supplied: params.supplied,
    options,
    interaction,
  });
  // a resize that restarted the machine ended the session the channel ran over
  const connection =
    resized === workstation
      ? params.connection
      : await reconnect(dependencies, {
          lost: params.connection,
          provider,
          resized,
        });
  try {
    const guest =
      connection === params.connection
        ? params.guest
        : await connection.guest();
    await persistPreparedProfile(dependencies, {
      resolved,
      guest,
      section,
      mutation: params.mutation,
    });

    return {
      guest,
      context: setupContextOf(params, {
        resolved,
        resized,
        connection,
        verifiedExitNode: exitNode,
      }),
    };
  } catch (error) {
    if (connection !== params.connection) {
      await connection.close();
    }
    throw error;
  }
}

/**
 * persists a changed selection only when the guest already records a profile
 * @param dependencies registered drivers and guest profile storage
 * @param params resolved selection, current channel, targeted section and mutation state
 * @param params.resolved validated selection and previously recorded environment
 * @param params.guest current guest channel, after any resize
 * @param params.section selected setup area
 * @param params.mutation diagnostic mutation state
 */
async function persistPreparedProfile(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  {
    resolved,
    guest,
    section,
    mutation,
  }: {
    resolved: ResolvedSetup;
    guest: GuestChannel;
    section: SetupSection;
    mutation: SetupProgress;
  },
): Promise<void> {
  if (resolved.persistsProfile && resolved.environment) {
    await persistSetupProfile(dependencies, {
      guest,
      profile: resolved.profile,
      context: {
        mutation,
        expected: resolved.recorded,
        section,
      },
    });
  }
}

/**
 * assembles the context a section is applied with
 * @param params target, selected section, input choices, and diagnostic state
 * @param parts the resolved state, the resized machine, the connection and the verified exit node
 * @returns complete setup context for the selected section
 */
function setupContextOf(
  params: SetupPreparationParams,
  parts: SetupContextParts,
): SetupContext {
  const { resolved, resized, connection, verifiedExitNode } = parts;
  const { profile, input } = resolved;

  return {
    provider: params.provider,
    workstation: resized,
    connection,
    options: params.options,
    interaction: params.interaction,
    input,
    profile,
    persistsProfile: resolved.persistsProfile,
    isReleaseChanged: resolved.isReleaseChanged,
    networkEnrolled: resolved.networkEnrolled,
    verifiedExitNode,
    mutation: params.mutation,
  };
}

/**
 * ends the session a resize cut short and binds a new one to the resized machine
 * @param dependencies the guest mechanics
 * @param params the call's inputs: lost, provider, resized
 * @returns the new, still unopened, connection
 */
async function reconnect(
  dependencies: Pick<ApplicationDependencies, 'guest'>,
  params: ReconnectParams,
): Promise<SetupSession> {
  const { lost, provider, resized } = params;
  await lost.close();

  return dependencies.guest.session.connect({
    provider,
    workstation: resized,
  });
}

/**
 * resolves every input the setup run needs, refusing when any stays unresolved
 * @param dependencies the registered drivers, the profile defaults, what this computer provides
 * @param params the call's inputs: setup, profile, state
 * @returns the resolved inputs
 */
async function resolveSetupInputs(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'defaults' | 'host'>,
  params: SetupInputsParams,
): Promise<ResolvedSetup['input']> {
  const { setup, profile, state } = params;
  const { options, interaction, sources } = setup;
  const input = await resolveInputs(dependencies, {
    options,
    interaction,
    requirementSelection: {
      required: state.persistsProfile
        ? selectionRequirements(dependencies, {
            profile: state.targeted,
            base: [],
            isEnrolled: state.networkEnrolled,
          })
        : [],
      profile,
      sources,
    },
  });
  if (input.missing.length > 0) {
    throw missingSetupInputs(input.missing);
  }

  return input;
}

/**
 * reads what the machine records, then resolves and validates the selection
 * and every input it needs, and tells whether the agent's release moves
 * @param dependencies the registered drivers, the profile defaults, the guest mechanics, what this computer provides
 * @param params target, selected section and input choices
 * @returns the recorded environment and profile, the validated profile, whether the release moves and the resolved inputs
 */
async function resolveSetup(
  dependencies: ApplicationDependencies,
  params: SetupPreparationParams,
): Promise<ResolvedSetup> {
  const { workstation, section, options, interaction, sources } = params;
  const environment = await readSetupEnvironment(
    dependencies,
    params.guest,
    section,
  );
  const recorded =
    environment?.profile ?? unrecordedProfile(dependencies, workstation);
  assertSameWorkstationKind(recorded, params.supplied);
  const profile = requireValidProfile(
    dependencies,
    await resolveSetupSelection(dependencies, {
      options,
      sources,
      interaction,
      recorded,
      section,
      supplied: params.supplied,
    }),
    options,
  );
  const persistsProfile = profileUpdateSelected(section, profile, recorded);
  const targeted = targetedProfile(section, profile);
  const networkEnrolled = await isNetworkEnrolled(dependencies, {
    guest: params.guest,
    environment,
    target: {
      isTargeted: targeted.network === recorded.network,
      profile,
    },
  });
  const state = { persistsProfile, targeted, networkEnrolled };
  const input = await resolveSetupInputs(dependencies, {
    setup: params,
    profile,
    state,
  });

  return {
    environment,
    recorded,
    profile,
    persistsProfile,
    targeted,
    networkEnrolled,
    isReleaseChanged: await isAgentReleaseChanged(dependencies, {
      section,
      connection: params.connection,
      guest: params.guest,
      interaction,
      resolved: { environment, recorded, profile },
    }),
    input,
  };
}

/**
 * reports every unresolved setup input, adding terminal guidance only when an
 * implicit blocker hid a required prompt
 * @param missing one actionable line per unresolved setup input
 * @returns the INPUT fault
 */
export function missingSetupInputs(missing: readonly string[]): CommandFault {
  const promptHint = promptUnavailableDetail();

  return new CommandFault({
    code: 'INPUT',
    message: 'Required setup inputs are missing',
    details: [...missing, ...(promptHint ? [promptHint] : [])],
  });
}
