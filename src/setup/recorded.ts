import { networkDriver } from '#core/networks';
import {
  DEFAULT_PROFILE_OPTIONS,
  defaultProfile,
  registeredSummary,
} from '#core/profile';
import { CommandFault } from '#errors';
import { findGuestEnvironment } from '#integrations/guest/environment/store';

import type { SetupSection } from '#command/contracts';
import type { WorkstationProfile } from '#core/profile';
import type { WorkstationRecord } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';
import type { GuestEnvironment } from '#integrations/guest/environment/contracts';

/**
 * reconstructs the selection of a workstation whose installation never wrote environment.json
 * @param workstation workstation with its provider-recorded summary
 * @returns the recorded driver selection with default options, or the default profile
 */
export function unrecordedProfile(
  workstation: WorkstationRecord,
): WorkstationProfile {
  const summary = registeredSummary(workstation.metadata.profile);

  return summary
    ? { ...summary, options: { ...DEFAULT_PROFILE_OPTIONS } }
    : defaultProfile();
}

/**
 * refuses a setup run that would move a workstation to another provider or
 * agent, before any other selection check
 * @param recorded selection the workstation was created with
 * @param supplied provider and ACP agent the run's flags request
 * @param supplied.provider requested provider driver id
 * @param supplied.agent requested ACP agent driver id
 * @throws {CommandFault} when the provider or ACP agent differs
 */
export function assertSameWorkstationKind(
  recorded: WorkstationProfile,
  supplied: { provider?: string; agent?: string },
): void {
  if (
    (supplied.provider !== undefined &&
      supplied.provider !== recorded.provider) ||
    (supplied.agent !== undefined && supplied.agent !== recorded.agent)
  ) {
    throw new CommandFault({
      code: 'INPUT',
      message: `Setup cannot change the provider (${recorded.provider}) or ACP agent (${recorded.agent}) of an existing workstation; a new workstation is required`,
    });
  }
}

/**
 * tells whether the guest is enrolled now, by asking the installed network
 * daemon; the identity environment.json recorded is cleanup data and never
 * proves enrolment, because a guest can lose its registration while the record stays
 * @param guest selected managed guest
 * @param environment recorded environment, absent before initial installation
 * @param target whether this run targets the installed network, and the selection
 * @param target.isTargeted whether this run targets the installed network
 * @param target.profile selection this run applies
 * @returns true when the live daemon reports a device identity
 */
export async function isNetworkEnrolled(
  guest: GuestChannel,
  environment: GuestEnvironment | undefined,
  target: { isTargeted: boolean; profile: WorkstationProfile },
): Promise<boolean> {
  return environment !== undefined && target.isTargeted
    ? Boolean(
        (await networkDriver(target.profile.network).status(guest)).deviceId,
      )
    : false;
}

/**
 * requires full recovery while the guest records no finished installation
 * @param guest selected managed guest
 * @param section requested setup scope
 * @returns the recorded environment, absent before setup first wrote it
 * @throws {CommandFault} when the installation is unfinished and the section is not `all`
 */
export async function readSetupEnvironment(
  guest: GuestChannel,
  section: SetupSection,
): Promise<GuestEnvironment | undefined> {
  const environment = await findGuestEnvironment(guest);
  if (environment?.setup.state !== 'ready' && section !== 'all') {
    throw new CommandFault({
      code: 'PREFLIGHT',
      message:
        'Initial installation is incomplete; recover with setup --section all',
    });
  }

  return environment;
}
