import { networkDriver } from '#core/networks';
import { networkManagement, resolveEnrollmentKey } from '#input/management';
import {
  assertGuestProfile,
  networkIdentityRecorder,
} from '#integrations/guest/manifest';
import {
  installGuestTools,
  installManagedServices,
  readGuestManifest,
} from '#integrations/guest/runtime';
import { withGuestTransaction } from '#integrations/guest/transaction';

import type { NetworkSetupData } from '#command/data';
import type { WorkstationProfile } from '#core/profile';
import type { NetworkExitNode } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';
import type { ResolvedInputs } from '#input/types';

import type { SetupContext } from './context.js';

/**
 * enrolls the selected network or update the existing device's exit route
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
  if (!network.daemon) {
    return { network: { status: 'disabled', readiness: 'skipped' } };
  }
  const { isExitNodeEnabled } = profile.options;
  if (
    network.inputs &&
    (!input.networkAccount || (isExitNodeEnabled && !input.exitNode))
  ) {
    throw new Error(`Validated ${network.displayName} inputs were unavailable`);
  }
  await installSelectedNetwork(guest, context);
  const verified = context.verifiedExitNode;
  const authKey =
    networkEnrolled || !network.inputs
      ? undefined
      : await resolveEnrollmentKey(network, input);

  return withGuestTransaction(guest, async () => {
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
    await installManagedServices(guest);
    const observed = await network.status(guest);
    if (
      selectedExitNode &&
      !network.matchesExitNode(selectedExitNode, observed)
    ) {
      throw new Error(
        `The selected exit node does not match current ${network.displayName} status`,
      );
    }

    return {
      network: {
        status: 'configured',
        exitNode: isExitNodeEnabled
          ? (verified?.name ?? input.exitNode)
          : undefined,
      },
    };
  });
}

/**
 * removes the device the manifest recorded for this workstation before it
 * enrols again, so the new device takes the workstation name
 * @param guest guest channel of the managed workstation
 * @param context selected profile and resolved network credentials
 */
async function removeRecordedDevice(
  guest: GuestChannel,
  context: Pick<SetupContext, 'profile' | 'input'>,
): Promise<void> {
  const network = networkDriver(context.profile.network);
  const recorded = (await readGuestManifest(guest)).networkIdentity;
  if (network.removeStaleDevice && recorded?.network === network.id) {
    await network.removeStaleDevice(guest, {
      recorded,
      management: networkManagement(context.input),
    });
  }
}

/**
 * installs the selected network's tool when the workstation never installed
 * it: a network is installed only while selected, so a switch to one the
 * workstation never had installs it first
 * @param guest guest channel of the managed workstation
 * @param context selected profile and mutation tracking
 */
async function installSelectedNetwork(
  guest: GuestChannel,
  context: Pick<SetupContext, 'profile' | 'mutation'>,
): Promise<void> {
  const { profile, mutation } = context;
  const { tools } = networkDriver(profile.network);
  if (tools.length === 0) {
    return;
  }
  const { installedVersions } = await readGuestManifest(guest);
  if (tools.some(({ name }) => installedVersions[name] === undefined)) {
    mutation.started = true;
    await installGuestTools(guest, profile);
  }
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
