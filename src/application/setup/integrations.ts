import { networksWithDaemon } from '#application/catalog/networks';
import { sectionFields } from '#application/input/selection';
import { disableNetwork } from '#application/setup/network';
import { NO_NETWORK } from '#domain/ids';

import type { NetworkWithDaemon } from '#application/catalog/networks';
import type { SetupSection } from '#application/contracts';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { WorkstationProfile } from '#domain/profile';

import type { SetupContext } from './context';

/** the named inputs of persist setup profile */
export interface PersistSetupProfileParams {
  /** selected managed guest */
  guest: GuestChannel;
  /** validated selection this run applies */
  profile: WorkstationProfile;
  /** recorded selection, targeted section and mutation tracking */
  context: Pick<SetupContext, 'mutation'> & {
    expected: WorkstationProfile;
    section: SetupSection;
  };
}

/**
 * persists a validated selection and stops every daemon the selection no
 * longer runs, including a stray daemon left on a workstation without a network;
 * the update gate reads the tools section's due interval from environment.json,
 * so storing it is the whole change. The setup session holds the guest's
 * setup lock, so nothing else changes the record meanwhile
 * @param dependencies the registered drivers, the guest mechanics
 * @param params the call's inputs: guest, profile, context
 */
export async function persistSetupProfile(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  params: PersistSetupProfileParams,
): Promise<void> {
  const { guest, profile, context } = params;
  const { mutation, expected, section } = context;
  await dependencies.guest.environment.assertProfile(guest, expected);
  mutation.started = true;
  const deselected = sectionFields(section).includes('network')
    ? await deselectedNetworks(dependencies, guest, { profile, expected })
    : [];
  for (const network of deselected) {
    await disableNetwork(
      {
        declarations: dependencies.registry,
        environment: dependencies.guest.environment,
      },
      guest,
      network,
    );
  }
  await dependencies.guest.environment.writeProfile(guest, profile);
}

/**
 * detects whether this setup invocation changes the persisted selection; the
 * tools section owns only the update due interval, so it changes the selection
 * only when the resolved interval differs from the recorded one, and the agent
 * section owns only the release channel, so it changes the selection only when
 * the resolved channel differs from the recorded one, whether a flag, the
 * environment or a prompt supplied it; a changed machine requirement is
 * persisted by every section, since any section may carry it
 * @param section selected setup area
 * @param profile validated selection this run applies
 * @param recorded selection recorded before this run
 * @returns whether profile persistence is required
 */
export function profileUpdateSelected(
  section: SetupSection,
  profile: WorkstationProfile,
  recorded: WorkstationProfile,
): boolean {
  if (isMachineChanged(profile, recorded)) {
    return true;
  }
  if (section === 'agent') {
    return isReleaseChanged(profile, recorded);
  }

  return section === 'tools'
    ? profile.options.updateDueIntervalDays !==
        recorded.options.updateDueIntervalDays
    : sectionFields(section).length > 0;
}

/**
 * detects whether a selection moves the ACP agent to another release channel
 * @param profile validated selection this run applies
 * @param recorded selection recorded before this run
 * @returns whether the channels differ
 */
export function isReleaseChanged(
  profile: WorkstationProfile,
  recorded: WorkstationProfile,
): boolean {
  return profile.options.agentRelease !== recorded.options.agentRelease;
}

/**
 * detects whether a selection changes the minimum machine size
 * @param profile validated selection this run applies
 * @param recorded selection recorded before this run
 * @returns whether the CPU or memory minimum differs
 */
function isMachineChanged(
  profile: WorkstationProfile,
  recorded: WorkstationProfile,
): boolean {
  return (
    profile.options.minCpus !== recorded.options.minCpus ||
    profile.options.minMemoryGb !== recorded.options.minMemoryGb
  );
}

/**
 * limits preflight credentials to the parts of the selection this run applies
 * @param section selected setup area
 * @param profile validated selection
 * @returns the profile with untargeted network and gateway choices cleared
 */
export function targetedProfile(
  section: SetupSection,
  profile: WorkstationProfile,
): WorkstationProfile {
  const fields = sectionFields(section);
  const isNetworkTargeted = fields.includes('network');
  const isProxyTargeted = fields.includes('isProxyEnabled');

  return {
    ...profile,
    network: isNetworkTargeted ? profile.network : NO_NETWORK,
    options: {
      ...profile.options,
      isExitNodeEnabled: isNetworkTargeted && profile.options.isExitNodeEnabled,
      isProxyEnabled: isProxyTargeted && profile.options.isProxyEnabled,
    },
  };
}

/**
 * lists the network daemons a selection stops: those of the networks the
 * selection does not run that the workstation recorded or still has registered,
 * so a workstation that never ran a network has nothing to release
 * @param dependencies the registered drivers
 * @param guest selected managed guest
 * @param selections the validated selection this run applies and the one the workstation recorded
 * @param selections.profile validated selection this run applies
 * @param selections.expected selection the workstation recorded
 * @returns network drivers whose daemon must be released
 */
async function deselectedNetworks(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  guest: GuestChannel,
  selections: { profile: WorkstationProfile; expected: WorkstationProfile },
): Promise<NetworkWithDaemon[]> {
  const { profile, expected } = selections;
  const others = networksWithDaemon(dependencies.registry).filter(
    ({ id }) => id !== profile.network,
  );
  if (others.length === 0) {
    return [];
  }
  const services = await guest.services.list();

  return others.filter(
    ({ id, daemon }) =>
      id === expected.network ||
      services.some(({ name }) => name === daemon.name),
  );
}
