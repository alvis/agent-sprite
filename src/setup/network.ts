import { networkDriver } from '#core/networks';
import { networkManagement, resolveEnrollmentKey } from '#input/management';
import {
  assertGuestProfile,
  networkIdentityRecorder,
  readGuestEnvironment,
} from '#integrations/guest/environment/store';
import { markInstallationReady } from '#integrations/guest/install';

import { installSetupPlan } from './install';

import type { NetworkSetupData } from '#command/data';
import type { WorkstationProfile } from '#core/profile';
import type { GuestChannel } from '#drivers/guest-channel';
import type { NetworkExitNode } from '#drivers/networks/contracts';
import type { ResolvedInputs } from '#input/types';

import type { SetupContext } from './context';

/**
 * enrolls the selected network or update the existing device's exit route;
 * when the network had to be installed, the installation is recorded ready
 * only once the device enrolled, so a failed enrolment leaves it `incomplete`
 * for recovery to find
 * @param guest guest channel of the managed workstation
 * @param context network choices, prompts, and redaction values
 * @returns selected network route summary
 */
export async function setupNetwork(
  guest: GuestChannel,
  context: SetupContext,
): Promise<NetworkSetupData> {
  const { input, profile, networkEnrolled, mutation } = context;
  const network = networkDriver(profile.network);
  const installed = await installSelectedNetwork(guest, context);
  if (!network.daemon) {
    if (installed) {
      await markInstallationReady(guest);
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
  await assertGuestProfile(guest, profile);
  mutation.started = true;
  if (!networkEnrolled) {
    await removeRecordedDevice(guest, context);
  }
  const selectedExitNode = isExitNodeEnabled
    ? (verified?.ip ?? input.exitNode)
    : undefined;
  await network.enroll(guest, {
    hostname: context.workstation.name,
    credential: authKey,
    exitNode: selectedExitNode,
    recordIdentity: networkIdentityRecorder(guest, network.id),
  });
  const observed = await network.status(guest);
  if (
    selectedExitNode &&
    !network.matchesExitNode(selectedExitNode, observed)
  ) {
    throw new Error(
      `The selected exit node does not match current ${network.displayName} status`,
    );
  }
  if (installed) {
    await markInstallationReady(guest);
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
 * removes the device environment.json recorded for this workstation before
 * it enrols again, so the new device takes the workstation name
 * @param guest guest channel of the managed workstation
 * @param context selected profile and resolved network credentials
 */
async function removeRecordedDevice(
  guest: GuestChannel,
  context: Pick<SetupContext, 'profile' | 'input'>,
): Promise<void> {
  const network = networkDriver(context.profile.network);
  const recorded = (await readGuestEnvironment(guest)).networkIdentity;
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
 * @param guest guest channel of the managed workstation
 * @param context provider, setup session, selected profile and mutation tracking
 * @returns whether the plan ran
 */
async function installSelectedNetwork(
  guest: GuestChannel,
  context: SetupContext,
): Promise<boolean> {
  const installed = (await readGuestEnvironment(guest)).network?.id;
  const selected = networkDriver(context.profile.network).daemon
    ? context.profile.network
    : undefined;
  if (installed === selected) {
    return false;
  }
  await installSetupPlan(context);

  return true;
}

/**
 * verifies selected exit routing before any setup mutation
 * @param input resolved local network credentials and selectors
 * @param targeted the part of the profile this setup run applies
 * @returns approved exit identity when caller-side management access is available
 */
export async function verifySetupExitNode(
  input: ResolvedInputs,
  targeted: WorkstationProfile,
): Promise<NetworkExitNode | undefined> {
  const network = networkDriver(targeted.network);
  const management = networkManagement(input);

  return network.supportsExitNode &&
    targeted.options.isExitNodeEnabled &&
    management?.account &&
    input.exitNode
    ? network.verifyExitNode(management, input.exitNode)
    : undefined;
}
