import {
  networkDriver,
  networksWithDaemon,
} from '#application/catalog/networks';
import { resolveInputs } from '#application/input';
import { networkManagement } from '#application/input/management';
import { defaultProfile } from '#domain/profile';

import { CommandFault } from '#kernel/faults';

import { runBoundedIO, traceStage } from '#kernel/operation';

import { commandError } from './failures';
import { selectManagedMachine } from './inspect';

import { summarizeMachine } from './machine';

import type { RegisteredNetwork } from '#application/catalog/networks';
import type {
  CommandRequest,
  WorkstationCommandParams,
} from '#application/contracts';
import type { TerminateData } from '#application/data';
import type { ResolvedInputs } from '#application/input/types';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { NetworkCleanup } from '#application/ports/drivers';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { Interaction } from '#application/ports/interaction';
import type { CommandResult } from '#application/result';
import type { NetworkStatus } from '#domain/observations/network';
import type { WorkstationProfile } from '#domain/profile';
import type { WorkstationRecord } from '#domain/workstation';

import type { MachineSummary } from './machine';

interface CleanupContext {
  workstation: WorkstationRecord;
  machine: MachineSummary;
  input: ResolvedInputs;
  capture: NetworkIdentityCapture;
}

/** the network a workstation's device belongs to, and its captured identity */
interface NetworkIdentityCapture {
  network?: RegisteredNetwork;
  identity?: NetworkStatus;
  /** the recorded profile, when it selects the captured network */
  profile?: WorkstationProfile;
}

/**
 * permanently deletes one verified managed workstation and report network cleanup separately
 * @param dependencies the registered drivers, the profile defaults, the guest mechanics, what this computer provides
 * @param params the call's inputs: request, provider, interaction
 * @returns exact deletion and any outstanding network cleanup outcome
 */
export async function terminateWorkstation(
  dependencies: ApplicationDependencies,
  params: WorkstationCommandParams,
): Promise<CommandResult> {
  const { request, provider, interaction } = params;
  if (!interaction && (!request.machine || !request.options.yes)) {
    throw new CommandFault({
      code: 'USAGE',
      message:
        'Non-interactive termination requires an exact workstation name and --yes',
    });
  }
  const workstation = await selectManagedMachine(dependencies, {
    provider,
    requestedName: request.machine,
    interaction,
    release: 'guest-or-metadata',
  });
  assertTerminationTarget(workstation, request);
  if (!(await confirmDeletion(workstation, request, interaction))) {
    return {
      command: 'terminate',
      ok: false,
      error: {
        code: 'CANCELLED',
        message: 'Typed name did not match; no resources were deleted',
      },
    };
  }
  const machine = summarizeMachine(dependencies, workstation);
  const capture = await captureNetworkIdentity(
    dependencies,
    await provider.openGuest(workstation),
  );
  const input = await assertSafeNetworkTarget(dependencies, request, capture);
  interaction?.progress({
    stage: 'terminate',
    message: `Deleting workstation ${workstation.name}`,
  });
  await traceStage({
    stage: 'terminate.provider',
    action: async () => provider.delete(workstation),
  });

  return traceStage({
    stage: 'terminate.network',
    action: async () =>
      cleanupNetwork({ workstation, machine, input, capture }),
    context: { succeeded: (result) => result.ok },
  });
}

/**
 * resolves the management credentials of the network that owns the device and
 * refuses a target that credential does not safely own
 * @param dependencies the registered drivers, the profile defaults, what this computer provides
 * @param request parsed termination target and options
 * @param capture the network and identity captured before deletion
 * @returns the inputs the later cleanup reuses
 */
async function assertSafeNetworkTarget(
  dependencies: ApplicationDependencies,
  request: CommandRequest,
  capture: NetworkIdentityCapture,
): Promise<ResolvedInputs> {
  // management credentials resolve only for the network that owns the device
  const input = await resolveInputs(dependencies, {
    options: request.options,
    requirementSelection: {
      required: [],
      profile: capture.network
        ? (capture.profile ??
          defaultProfile(dependencies.defaults, capture.network.id))
        : undefined,
    },
  });
  if (capture.network && capture.identity) {
    await capture.network.assertSafeTarget({
      identity: capture.identity,
      management: networkManagement(input),
      exitNode: input.exitNode,
    });
  }

  return input;
}

/**
 * captures enrolled identity without requiring a completed installation; the
 * network environment.json recorded the identity for owns the device, then the
 * selected network, then any other network that runs a daemon and still holds
 * enrollment state, so a network deselected earlier is still cleaned up
 * @param dependencies the registered drivers, the guest mechanics
 * @param guest ownership-checked target before permanent deletion
 * @returns the owning network and its captured identity, if any
 */
async function captureNetworkIdentity(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  guest: GuestChannel,
): Promise<NetworkIdentityCapture> {
  const environment = (await runBoundedIO(async () =>
    guest.exists(dependencies.guest.facts.environmentPath),
  ))
    ? await dependencies.guest.environment.read(guest)
    : undefined;
  const selected =
    environment &&
    networkDriver(dependencies.registry, environment.profile.network);
  const recorded = environment?.networkIdentity;
  const candidates = networksWithDaemon(dependencies.registry);
  const ordered = [
    ...candidates.filter(({ id }) => id === recorded?.network),
    ...candidates.filter(({ id }) => id === selected?.id),
    ...candidates,
  ].filter((network, index, all) => all.indexOf(network) === index);
  let fallback: NetworkIdentityCapture = {};
  for (const network of ordered) {
    const isSelected = network.id === selected?.id;
    const identity = await network.identify(guest, {
      identity:
        recorded?.network === network.id
          ? { deviceId: recorded.deviceId, ip: recorded.ip }
          : undefined,
    });
    const capture = {
      network,
      identity,
      profile: isSelected ? environment?.profile : undefined,
    };
    if (identity.deviceId || identity.ip) {
      return capture;
    }
    if (isSelected) {
      fallback = capture;
    }
  }

  return fallback;
}

/**
 * requires an exact typed name unless the caller supplied exact target and consent
 * @param workstation the ownership-checked live workstation
 * @param request parsed target and non-interactive consent
 * @param interaction optional inline confirmation prompt
 * @returns whether deletion was confirmed
 */
async function confirmDeletion(
  workstation: WorkstationRecord,
  request: CommandRequest,
  interaction?: Interaction,
): Promise<boolean> {
  if (
    !interaction ||
    (request.options.yes &&
      request.machine !== undefined &&
      request.machine.length > 0)
  ) {
    return true;
  }
  interaction.status({
    kind: 'warning',
    message: `Permanently deleting ${workstation.name} (${workstation.id}) destroys its filesystem and repositories.`,
  });
  const typedName = await interaction.input({
    message: `Type ${workstation.name} to delete it`,
    required: true,
  });

  return typedName === workstation.name;
}

/**
 * deletes the captured device after workstation deletion, or report work remaining
 * @param context captured identities and local management credential
 * @returns separate workstation and network cleanup statuses
 */
async function cleanupNetwork(context: CleanupContext): Promise<CommandResult> {
  const { capture, input } = context;

  return cleanupResult(
    context,
    capture.network && capture.identity
      ? await capture.network.cleanup({
          identity: {
            deviceId: capture.identity.deviceId,
            ip: capture.identity.ip,
          },
          management: networkManagement(input),
        })
      : { ok: true, status: 'no device identity recorded' },
  );
}

/**
 * reports exact provider deletion separately from subsequent network cleanup
 * @param context captured identities and machine summary
 * @param outcome current network cleanup status and optional failure
 * @returns structured termination outcome
 */
function cleanupResult(
  context: CleanupContext,
  outcome: NetworkCleanup,
): CommandResult {
  const { ok, status, cause } = outcome;
  const { workstation, machine, capture } = context;
  const deviceId = capture.identity?.deviceId;
  const address = capture.identity?.ip;
  const data: TerminateData = {
    machine,
    workstation: { status: 'deleted', id: machine.id, name: workstation.name },
    network: { status, deviceId, address },
  };
  const network = capture.network?.displayName ?? 'network';
  if (ok) {
    return { command: 'terminate', ok: true, data };
  }
  const reason = cause?.message ?? 'unknown cleanup failure';
  const message = cause
    ? `Workstation deleted; ${network} cleanup for ${deviceId ?? address ?? 'the recorded device'} could not be confirmed: ${reason}`
    : `Workstation deleted; ${network} device ${deviceId ?? address} needs management-API cleanup`;

  return {
    command: 'terminate',
    ok: false,
    data,
    error: {
      code: cause ? commandError(cause).code : 'INPUT',
      message,
      machine: workstation.name,
      machineId: workstation.id,
    },
  };
}

/**
 * checks immutable identity and the exact requested name before deletion consent
 * @param workstation selected provider workstation
 * @param request explicitly requested deletion target
 */
function assertTerminationTarget(
  workstation: WorkstationRecord,
  request: CommandRequest,
): void {
  if (!workstation.id || !workstation.organization) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: 'Selected workstation lacks immutable provider identity',
    });
  }
  if (request.machine && request.machine !== workstation.name) {
    throw new CommandFault({
      code: 'CONFLICT',
      message:
        'Named termination target does not match the verified workstation; no resources were deleted',
    });
  }
}
