import { networkDriver } from '#application/catalog/networks';

import {
  networkManagement,
  resolveEnrollmentKey,
} from '#application/input/management';

import { markInstallationReady } from '#application/installation/readiness';

import { installSetupPlan } from './install';

import type { RegisteredNetwork } from '#application/catalog/networks';

import type { NetworkSetupData } from '#application/data';
import type { ResolvedInputs } from '#application/input/types';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { NetworkExitNode } from '#application/ports/drivers';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { WorkstationProfile } from '#domain/profile';

import type { SetupContext } from './context';

/**
 * enrolls the selected network or update the existing device's exit route;
 * when the network had to be installed, the installation is recorded ready
 * only once the device enrolled, so a failed enrolment leaves it `incomplete`
 * for recovery to find
 * @param dependencies the registered drivers, the guest mechanics
 * @param guest guest channel of the managed workstation
 * @param context network choices, prompts, and redaction values
 * @returns selected network route summary
 */
export async function setupNetwork(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  guest: GuestChannel,
  context: SetupContext,
): Promise<NetworkSetupData> {
  const { input, profile, networkEnrolled, mutation } = context;
  const network = networkDriver(dependencies.registry, profile.network);
  const installed = await installSelectedNetwork(dependencies, guest, context);
  if (!network.daemon) {
    if (installed) {
      await markInstallationReady(dependencies.guest, guest);
    }

    return { network: { status: 'disabled', readiness: 'skipped' } };
  }
  const { isExitNodeEnabled } = profile.options;
  if (
    network.inputs &&
    (!input.networkAccount || (isExitNodeEnabled && !input.exitNode))
  ) {
    throw new Error(`Validated ${network.displayName} inputs were unavailable`);
  }
  const verified = context.verifiedExitNode;
  const authKey =
    networkEnrolled || !network.inputs
      ? undefined
      : await resolveEnrollmentKey(network, input);
  await dependencies.guest.environment.assertProfile(guest, profile);
  mutation.started = true;
  if (!networkEnrolled) {
    await removeRecordedDevice(dependencies, guest, context);
  }
  const selectedExitNode = isExitNodeEnabled
    ? (verified?.ip ?? input.exitNode)
    : undefined;
  await network.enroll(guest, {
    hostname: context.workstation.name,
    credential: authKey,
    exitNode: selectedExitNode,
    recordIdentity: dependencies.guest.environment.identityRecorder(
      guest,
      network.id,
    ),
  });
  await assertExitNodeActive(guest, network, selectedExitNode);
  if (installed) {
    await markInstallationReady(dependencies.guest, guest);
  }

  return {
    network: {
      status: 'configured',
      exitNode: isExitNodeEnabled
        ? (verified?.name ?? input.exitNode)
        : undefined,
    },
  };
}

/**
 * refuses to go on when the enrolled device does not route through the
 * selected exit node
 * @param guest guest channel of the managed workstation
 * @param network the enrolled network
 * @param exitNode address of the selected exit node, if any
 * @throws {Error} when the network's status does not match the exit node
 */
async function assertExitNodeActive(
  guest: GuestChannel,
  network: RegisteredNetwork,
  exitNode: string | undefined,
): Promise<void> {
  const observed = await network.status(guest);
  if (exitNode && !network.matchesExitNode(exitNode, observed)) {
    throw new Error(
      `The selected exit node does not match current ${network.displayName} status`,
    );
  }
}

/**
 * removes the device environment.json recorded for this workstation before
 * it enrols again, so the new device takes the workstation name
 * @param dependencies the registered drivers, the guest mechanics
 * @param guest guest channel of the managed workstation
 * @param context selected profile and resolved network credentials
 */
async function removeRecordedDevice(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  guest: GuestChannel,
  context: Pick<SetupContext, 'profile' | 'input'>,
): Promise<void> {
  const network = networkDriver(dependencies.registry, context.profile.network);
  const recorded = (await dependencies.guest.environment.read(guest))
    .networkIdentity;
  if (network.removeStaleDevice && recorded?.network === network.id) {
    await network.removeStaleDevice(guest, {
      recorded,
      management: networkManagement(context.input),
    });
  }
}

/**
 * runs the setup plan when the network the last plan installed is not the
 * selected one: a network's tool, daemon and the agent's dependency on it are
 * installed only while it is selected, so a switch installs the new one and
 * drops the old one before the device enrols; the record the plan writes
 * stays `incomplete` until the caller has enrolled the device
 * @param dependencies the registered drivers, the guest mechanics
 * @param guest guest channel of the managed workstation
 * @param context provider, setup session, selected profile and mutation tracking
 * @returns whether the plan ran
 */
async function installSelectedNetwork(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  guest: GuestChannel,
  context: SetupContext,
): Promise<boolean> {
  const installed = (await dependencies.guest.environment.read(guest)).network
    ?.id;
  const selected = networkDriver(dependencies.registry, context.profile.network)
    .daemon
    ? context.profile.network
    : undefined;
  if (installed === selected) {
    return false;
  }
  await installSetupPlan(dependencies, context);

  return true;
}

/**
 * verifies selected exit routing before any setup mutation
 * @param dependencies the registered drivers
 * @param input resolved local network credentials and selectors
 * @param targeted the part of the profile this setup run applies
 * @returns approved exit identity when caller-side management access is available
 */
export async function verifySetupExitNode(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  input: ResolvedInputs,
  targeted: WorkstationProfile,
): Promise<NetworkExitNode | undefined> {
  const network = networkDriver(dependencies.registry, targeted.network);
  const management = networkManagement(input);

  return network.supportsExitNode &&
    targeted.options.isExitNodeEnabled &&
    management?.account &&
    input.exitNode
    ? network.verifyExitNode(management, input.exitNode)
    : undefined;
}
