import { networkDriver } from '#application/catalog/networks';
import { defaultProfile, registeredSummary } from '#domain/profile';
import { CommandFault } from '#kernel/faults';

import type { SetupSection } from '#application/contracts';
import type { SuppliedSelection } from '#application/input/selection/supplied';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { GuestEnvironment } from '#domain/observations/environment';
import type { WorkstationProfile } from '#domain/profile';
import type { WorkstationRecord } from '#domain/workstation';

/** optional provider and agent restrictions supplied to setup */
type SuppliedWorkstationKind = Pick<SuppliedSelection, 'provider' | 'agent'>;

/**
 * reconstructs the selection of a workstation whose installation never wrote environment.json
 * @param dependencies the registered drivers, the profile defaults
 * @param workstation workstation with its provider-recorded summary
 * @returns the recorded driver selection with default options, or the default profile
 */
export function unrecordedProfile(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'defaults'>,
  workstation: WorkstationRecord,
): WorkstationProfile {
  const summary = registeredSummary(
    dependencies.registry,
    workstation.metadata.profile,
  );

  return summary
    ? { ...summary, options: { ...dependencies.defaults.options } }
    : defaultProfile(dependencies.defaults);
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
  supplied: SuppliedWorkstationKind,
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

/** the named inputs of is network enrolled */
export interface IsNetworkEnrolledParams {
  /** selected managed guest */
  guest: GuestChannel;
  /** recorded environment, absent before initial installation */
  environment: GuestEnvironment | undefined;
  /** whether this run targets the installed network, and the selection */
  target: { isTargeted: boolean; profile: WorkstationProfile };
}

/**
 * tells whether the guest is enrolled now, by asking the installed network
 * daemon; the identity environment.json recorded is cleanup data and never
 * proves enrolment, because a guest can lose its registration while the record stays
 * @param dependencies the registered drivers
 * @param params the call's inputs: guest, environment, target
 * @returns true when the live daemon reports a device identity
 */
export async function isNetworkEnrolled(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  params: IsNetworkEnrolledParams,
): Promise<boolean> {
  const { guest, environment, target } = params;

  return environment !== undefined && target.isTargeted
    ? Boolean(
        (
          await networkDriver(
            dependencies.registry,
            target.profile.network,
          ).status(guest)
        ).deviceId,
      )
    : false;
}

/**
 * requires full recovery while the guest records no finished installation
 * @param dependencies the guest mechanics
 * @param guest selected managed guest
 * @param section requested setup scope
 * @returns the recorded environment, absent before setup first wrote it
 * @throws {CommandFault} when the installation is unfinished and the section is not `all`
 */
export async function readSetupEnvironment(
  dependencies: Pick<ApplicationDependencies, 'guest'>,
  guest: GuestChannel,
  section: SetupSection,
): Promise<GuestEnvironment | undefined> {
  const environment = await dependencies.guest.environment.find(guest);
  if (environment?.setup.state !== 'ready' && section !== 'all') {
    throw new CommandFault({
      code: 'PREFLIGHT',
      message:
        'Initial installation is incomplete; recover with setup --section all',
    });
  }

  return environment;
}
