import { CommandFault } from '#errors';
import { requireValidProfile, resolveInputs } from '#input';
import { resolveSetupSelection, selectionRequirements } from '#input/selection';
import { SetupConnection } from '#integrations/guest/connection';
import { promptUnavailableDetail } from '#operation';

import {
  isReleaseChanged,
  persistSetupProfile,
  profileUpdateSelected,
  targetedProfile,
} from './integrations.js';
import { verifySetupExitNode } from './network.js';
import {
  assertSameWorkstationKind,
  isNetworkEnrolled,
  readSetupEnvironment,
  unrecordedProfile,
} from './recorded.js';
import { resizeWhenRequested } from './resize.js';

import type {
  CommandOptions,
  Interaction,
  SetupSection,
} from '#command/contracts';
import type { WorkstationProfile } from '#core/profile';
import type { ProviderDriver, WorkstationRecord } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';
import type { SuppliedSelection } from '#input/selection-supplied';
import type { InputSources } from '#input/sources';

import type { SetupContext, SetupProgress } from './context.js';

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
  connection: SetupConnection;
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

/**
 * resolves, validates and persists the setup selection before section mutations
 * @param params target, selected section, input choices, and diagnostic state
 * @returns complete setup context for the selected section and the channel to apply it through
 */
export async function prepareSetupContext(
  params: SetupPreparationParams,
): Promise<PreparedSetup> {
  const { provider, workstation, section, options, interaction } = params;
  const { environment, recorded, profile, input, ...decided } =
    await resolveSetup(params);
  const verifiedExitNode = await verifySetupExitNode(input, decided.targeted);
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
      : await reconnect(params.connection, provider, resized);
  try {
    const guest =
      connection === params.connection
        ? params.guest
        : await connection.guest();
    if (decided.persistsProfile && environment) {
      await persistSetupProfile(guest, profile, {
        mutation: params.mutation,
        expected: recorded,
        section,
      });
    }

    return {
      guest,
      context: {
        provider,
        workstation: resized,
        connection,
        options,
        interaction,
        input,
        profile,
        persistsProfile: decided.persistsProfile,
        isReleaseChanged: isReleaseChanged(profile, recorded),
        networkEnrolled: decided.networkEnrolled,
        verifiedExitNode,
        mutation: params.mutation,
      },
    };
  } catch (error) {
    if (connection !== params.connection) {
      await connection.close();
    }
    throw error;
  }
}

/**
 * ends the session a resize cut short and binds a new one to the resized machine
 * @param lost the session that ran on the machine before it restarted
 * @param provider the provider that opens the new session
 * @param resized the machine as resized
 * @returns the new, still unopened, connection
 */
async function reconnect(
  lost: SetupConnection,
  provider: ProviderDriver,
  resized: WorkstationRecord,
): Promise<SetupConnection> {
  await lost.close();

  return new SetupConnection(provider, resized);
}

/**
 * reads what the machine records, then resolves and validates the selection
 * and every input it needs
 * @param params target, selected section and input choices
 * @returns the recorded environment and profile, the validated profile and the resolved inputs
 */
async function resolveSetup(params: SetupPreparationParams): Promise<{
  environment: Awaited<ReturnType<typeof readSetupEnvironment>>;
  recorded: WorkstationProfile;
  profile: WorkstationProfile;
  persistsProfile: boolean;
  targeted: ReturnType<typeof targetedProfile>;
  networkEnrolled: boolean;
  input: Awaited<ReturnType<typeof resolveInputs>>;
}> {
  const { workstation, section, options, interaction, sources } = params;
  const environment = await readSetupEnvironment(params.guest, section);
  const recorded = environment?.profile ?? unrecordedProfile(workstation);
  assertSameWorkstationKind(recorded, params.supplied);
  const profile = requireValidProfile(
    await resolveSetupSelection({
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
  const networkEnrolled = await isNetworkEnrolled(params.guest, environment, {
    isTargeted: targeted.network === recorded.network,
    profile,
  });
  const input = await resolveInputs(options, interaction, {
    required: persistsProfile
      ? selectionRequirements(targeted, [], networkEnrolled)
      : [],
    profile,
    sources,
  });
  if (input.missing.length > 0) {
    throw new CommandFault({
      code: 'INPUT',
      message: missingSetupMessage(input.missing),
    });
  }

  return {
    environment,
    recorded,
    profile,
    persistsProfile,
    targeted,
    networkEnrolled,
    input,
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
