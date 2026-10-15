import { NO_NETWORK } from '#core/catalog';
import { networksWithDaemon } from '#core/networks';
import { sectionFields } from '#input/selection';
import { writeComponentCatalog } from '#integrations/guest/component-catalog';
import { assertGuestProfile } from '#integrations/guest/manifest';
import { disableNetwork } from '#integrations/guest/network';
import { writeGuestProfile } from '#integrations/guest/runtime';
import { installUpdateSchedule } from '#integrations/guest/services';
import { withGuestTransaction } from '#integrations/guest/transaction';

import type { SetupSection } from '#command/contracts';
import type { NetworkWithDaemon } from '#core/networks';
import type { WorkstationProfile } from '#core/profile';
import type { GuestChannel } from '#drivers/guest-channel';

import type { SetupContext } from './context.js';

/**
 * persists a validated selection and stops every daemon the selection no
 * longer runs, including a stray daemon left on a workstation without a network;
 * the tools section stores its intervals and installs the schedule they name in
 * the same transaction, so the profile and the schedule cannot drift apart
 * @param guest selected managed guest
 * @param profile validated selection this run applies
 * @param context recorded selection, targeted section and mutation tracking
 * @param context.mutation tracks whether setup changed guest state
 * @param context.expected selection observed before collecting user input
 * @param context.section setup area this run targets
 */
export async function persistSetupProfile(
  guest: GuestChannel,
  profile: WorkstationProfile,
  context: Pick<SetupContext, 'mutation'> & {
    expected: WorkstationProfile;
    section: SetupSection;
  },
): Promise<void> {
  const { mutation, expected, section } = context;
  await withGuestTransaction(guest, async () => {
    await assertGuestProfile(guest, expected);
    mutation.started = true;
    const deselected = sectionFields(section).includes('network')
      ? await deselectedNetworks(guest, { profile, expected })
      : [];
    for (const network of deselected) {
      await disableNetwork(guest, network);
    }
    await writeGuestProfile(guest, profile);
    // the updater reads the catalog, so it must follow the new channel from
    // this moment, not only from the next install
    if (isReleaseChanged(profile, expected)) {
      await writeComponentCatalog(guest, profile);
    }
    if (section === 'tools') {
      await installUpdateSchedule(
        guest,
        profile.options.updateCheckIntervalMinutes,
      );
    }
  });
}

/**
 * detects whether this setup invocation changes the persisted selection; the
 * tools section owns only the update intervals, so it changes the selection
 * only when a resolved interval differs from the recorded one, and the agent
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
    ? profile.options.updateCheckIntervalMinutes !==
        recorded.options.updateCheckIntervalMinutes ||
        profile.options.updateDueIntervalDays !==
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
export function isMachineChanged(
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
 * @param guest selected managed guest
 * @param selections the validated selection this run applies and the one the workstation recorded
 * @param selections.profile validated selection this run applies
 * @param selections.expected selection the workstation recorded
 * @returns network drivers whose daemon must be released
 */
async function deselectedNetworks(
  guest: GuestChannel,
  selections: { profile: WorkstationProfile; expected: WorkstationProfile },
): Promise<NetworkWithDaemon[]> {
  const { profile, expected } = selections;
  const others = networksWithDaemon().filter(
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
