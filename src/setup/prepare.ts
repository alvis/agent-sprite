import { CommandFault } from '#errors';
import { requireValidProfile, resolveInputs } from '#input';
import { resolveSetupSelection, selectionRequirements } from '#input/selection';
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
  readSetupManifest,
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
import type { SuppliedSelection } from '#input/selection';
import type { InputSources } from '#input/sources';

import type { SetupContext, SetupProgress } from './context.js';

/** what a setup run is prepared from */
export interface SetupPreparationParams {
  /** authenticated provider driver */
  provider: ProviderDriver;
  /** values the run's flags and section-scoped environment supply, already validated */
  supplied: SuppliedSelection;
  /** sources the supplied values were read from */
  sources: InputSources;
  /** machine the section is applied to */
  workstation: WorkstationRecord;
  /** channel opened to the machine */
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
export interface PreparedSetup {
  /** complete setup context for the selected section */
  context: SetupContext;
  /** guest channel to apply the section through; a new one when a resize restarted the machine */
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
  const { manifest, recorded, profile, input, ...decided } =
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
  // a resize that restarted the machine ended the run the channel belonged to
  const guest =
    resized === workstation ? params.guest : await provider.openGuest(resized);
  if (decided.persistsProfile && manifest) {
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
      options,
      interaction,
      input,
      profile,
      persistsProfile: decided.persistsProfile,
      isReleaseChanged: isReleaseChanged(profile, recorded),
      networkEnrolled: decided.networkEnrolled,
      verifiedExitNode,
      initialInstallation: !manifest || workstation.metadata.setup !== 'ready',
      mutation: params.mutation,
    },
  };
}

/**
 * reads what the machine records, then resolves and validates the selection
 * and every input it needs
 * @param params target, selected section and input choices
 * @returns the recorded manifest and profile, the validated profile and the resolved inputs
 */
async function resolveSetup(params: SetupPreparationParams): Promise<{
  manifest: Awaited<ReturnType<typeof readSetupManifest>>;
  recorded: WorkstationProfile;
  profile: WorkstationProfile;
  persistsProfile: boolean;
  targeted: ReturnType<typeof targetedProfile>;
  networkEnrolled: boolean;
  input: Awaited<ReturnType<typeof resolveInputs>>;
}> {
  const { workstation, section, options, interaction, sources } = params;
  const manifest = await readSetupManifest(params.guest, section);
  const recorded = manifest?.profile ?? unrecordedProfile(workstation);
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
  const networkEnrolled = await isNetworkEnrolled(params.guest, manifest, {
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
    manifest,
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
