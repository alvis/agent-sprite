import { resolveInputs } from '#input';

import {
  inspectTailscale,
  readGuestManifest,
} from '#integrations/guest/runtime';
import { deleteManagedSprite } from '#integrations/sprites';
import { deleteTailnetDevice, resolveExitNode } from '#integrations/tailscale';

import { CommandFault, ensureError, commandError } from './errors.js';
import { selectManagedMachine } from './inspect.js';
import { summarizeMachine } from './machine.js';
import {
  checkOperation,
  runBoundedIO,
  currentOperation,
  cancellationReason,
  traceStage,
} from './operation.js';

import type { SpritesClient, Sprite } from '@fly/sprites';

import type { CommandResult } from '#command';
import type { CommandRequest, Interaction } from '#command/contracts';
import type { TerminateData } from '#command/data';
import type { ResolvedInputs } from '#input/types';
import type { TailnetStatus } from '#integrations/guest/types';

import type { MachineSummary } from './machine.js';

interface CleanupContext {
  sprite: Sprite;
  machine: MachineSummary;
  input: ResolvedInputs;
  guestNodeId?: string;
  tailnetIp?: string;
}

interface CleanupOutcome {
  ok: boolean;
  status:
    | 'no device identity recorded'
    | 'cleanup required'
    | 'deleted'
    | 'cleanup failed';
  cause?: Error;
}

/**
 * permanently deletes one verified managed Sprite and report tailnet cleanup separately
 * @param request parsed termination target and confirmation options
 * @param client authenticated provider client
 * @param interaction optional inline confirmation and progress boundary
 * @returns exact deletion and any outstanding tailnet cleanup outcome
 */
export async function terminateWorkstation(
  request: CommandRequest,
  client: SpritesClient,
  interaction?: Interaction,
): Promise<CommandResult> {
  if (!interaction && (!request.machine || !request.options.yes)) {
    throw new CommandFault({
      code: 'USAGE',
      message:
        'Non-interactive termination requires an exact workstation name and --yes',
    });
  }
  const sprite = await selectManagedMachine(
    client,
    request.machine,
    interaction,
  );
  assertTerminationTarget(sprite, request);
  if (!(await confirmDeletion(sprite, request, interaction))) {
    return {
      command: 'terminate',
      ok: false,
      error: {
        code: 'CANCELLED',
        message: 'Typed name did not match; no resources were deleted',
      },
    };
  }
  const input = await resolveInputs(request.options, undefined, []);
  const machine = summarizeMachine(sprite);
  const state = await captureTailnetIdentity(sprite);
  await assertSafeTailnetTarget(input, state);
  interaction?.progress({
    stage: 'terminate',
    message: `Deleting Sprite ${sprite.name}`,
  });
  await traceStage('terminate.provider', async () =>
    deleteManagedSprite(client, {
      name: sprite.name,
      expectedId: machine.id,
      expectedOrganization: machine.organization,
    }),
  );

  return traceStage(
    'terminate.tailnet',
    async () =>
      cleanupTailnet({
        sprite,
        machine,
        input,
        guestNodeId: state.deviceId,
        tailnetIp: state.ip,
      }),
    { succeeded: (result) => result.ok },
  );
}

/**
 * captures enrolled identity without requiring a completed installation
 * @param sprite ownership-checked target before permanent deletion
 * @returns captured native or persisted managed tailnet identity
 */
async function captureTailnetIdentity(sprite: Sprite): Promise<TailnetStatus> {
  const filesystem = sprite.filesystem();
  const manifest = (await runBoundedIO(async () =>
    filesystem.exists('/opt/agent-sprite/manifest.json'),
  ))
    ? await readGuestManifest(sprite)
    : undefined;
  const offline = {
    ...manifest?.tailnetIdentity,
    online: false,
    dnsReady: false,
    skipped: true,
  };
  if (
    manifest?.integrations?.tailscale === false ||
    !(await runBoundedIO(async () =>
      filesystem.exists('/var/lib/tailscale/tailscaled.state'),
    ))
  ) {
    return offline;
  }
  let inspected: TailnetStatus | undefined;
  let inspectionFailure: { cause: unknown } | undefined;
  try {
    inspected = await inspectTailscale(sprite);
  } catch (error) {
    checkOperation();
    if (commandError(error).code === 'CANCELLED') {
      throw error;
    }
    inspectionFailure = { cause: error };
  }
  if (inspected?.deviceId) {
    return inspected;
  }
  if (offline.deviceId) {
    return inspected
      ? {
          ...inspected,
          deviceId: offline.deviceId,
          ip: inspected.ip ?? offline.ip,
        }
      : offline;
  }
  throw new CommandFault({
    code: inspectionFailure ? 'PROVIDER' : 'PREFLIGHT',
    message:
      'Tailnet enrollment state exists but its device identity could not be captured; recover setup before termination. No resources were deleted.',
    cause: inspectionFailure?.cause,
    causeVisibility: 'private',
  });
}

/**
 * requires an exact typed name unless the caller supplied exact target and consent
 * @param sprite the ownership-checked live Sprite
 * @param request parsed target and non-interactive consent
 * @param interaction optional inline confirmation prompt
 * @returns whether deletion was confirmed
 */
async function confirmDeletion(
  sprite: Sprite,
  request: CommandRequest,
  interaction?: Interaction,
): Promise<boolean> {
  if (
    !interaction ||
    (request.options.yes &&
      request.machine !== undefined &&
      request.machine.length > 0 &&
      request.machine === sprite.name)
  ) {
    return true;
  }
  interaction.status({
    kind: 'warning',
    message: `Permanently deleting ${sprite.name} (${sprite.id}) destroys its filesystem and repositories.`,
  });
  const typedName = await interaction.input({
    message: `Type ${sprite.name} to delete it`,
    required: true,
  });

  return typedName === sprite.name;
}

/**
 * protects the selected home exit node from cleanup even under a bad identity
 * @param input local management credential and selected home exit node
 * @param state current guest tailnet identity and selected route
 */
async function assertSafeTailnetTarget(
  input: ResolvedInputs,
  state: TailnetStatus,
): Promise<void> {
  const { deviceId: guestNodeId, ip: tailnetIp, exitNode: exitNodeId } = state;
  if (guestNodeId && guestNodeId === exitNodeId) {
    throw new CommandFault({
      code: 'CONFLICT',
      message: 'Refusing to delete a Sprite configured as its own exit node',
    });
  }
  if (
    !guestNodeId ||
    !input.tailscaleApiKey ||
    !input.tailnet ||
    !input.exitNode
  ) {
    return;
  }
  const homeNode = await resolveExitNode(
    input.tailscaleApiKey,
    input.tailnet,
    input.exitNode,
  );
  if (homeNode.id === guestNodeId || homeNode.ip === tailnetIp) {
    throw new CommandFault({
      code: 'CONFLICT',
      message: 'Refusing to delete the selected home exit node',
    });
  }
}

/**
 * deletes the captured guest node after Sprite deletion, or report work remaining
 * @param context captured identities and local management credential
 * @returns separate Sprite and tailnet cleanup statuses
 */
async function cleanupTailnet(context: CleanupContext): Promise<CommandResult> {
  const { guestNodeId, tailnetIp, input } = context;
  if (currentOperation()?.signal.aborted) {
    return cleanupResult(context, {
      ok: false,
      status: 'cleanup required',
      cause: cancellationReason(),
    });
  }
  if (!guestNodeId && !tailnetIp) {
    return cleanupResult(context, {
      ok: true,
      status: 'no device identity recorded',
    });
  }
  if (!input.tailscaleApiKey || !guestNodeId) {
    return cleanupResult(context, { ok: false, status: 'cleanup required' });
  }
  try {
    await deleteTailnetDevice(input.tailscaleApiKey, guestNodeId);

    return cleanupResult(context, { ok: true, status: 'deleted' });
  } catch (error) {
    return cleanupResult(context, {
      ok: false,
      status: 'cleanup failed',
      cause: ensureError(error),
    });
  }
}

/**
 * reports exact provider deletion separately from subsequent tailnet cleanup
 * @param context captured identities and machine summary
 * @param outcome current tailnet cleanup status and optional failure
 * @returns structured termination outcome
 */
function cleanupResult(
  context: CleanupContext,
  outcome: CleanupOutcome,
): CommandResult {
  const { ok, status, cause } = outcome;
  const { sprite, machine, guestNodeId, tailnetIp } = context;
  const data: TerminateData = {
    machine,
    sprite: { status: 'deleted', id: machine.id, name: sprite.name },
    tailnet: { status, deviceId: guestNodeId, tailnetIp },
  };
  if (ok) {
    return { command: 'terminate', ok: true, data };
  }
  const reason = cause?.message ?? 'unknown cleanup failure';
  const message = cause
    ? `Sprite deleted; tailnet cleanup for ${guestNodeId ?? tailnetIp ?? 'the recorded device'} could not be confirmed: ${reason}`
    : `Sprite deleted; tailnet device ${guestNodeId ?? tailnetIp} needs management-API cleanup`;

  return {
    command: 'terminate',
    ok: false,
    data,
    error: {
      code: cause ? commandError(cause).code : 'INPUT',
      message,
      machine: sprite.name,
      machineId: sprite.id,
    },
  };
}

/**
 * checks immutable identity and the exact requested name before deletion consent
 * @param sprite selected provider workstation
 * @param request explicitly requested deletion target
 */
function assertTerminationTarget(
  sprite: Sprite,
  request: CommandRequest,
): void {
  if (!sprite.id || !sprite.organizationName) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: 'Selected Sprite lacks immutable provider identity',
    });
  }
  if (request.machine && request.machine !== sprite.name) {
    throw new CommandFault({
      code: 'CONFLICT',
      message:
        'Named termination target does not match the verified Sprite; no resources were deleted',
    });
  }
}
