import { inspectGuest } from '#integrations/guest/runtime';

import { pairT3 } from '#integrations/native';

import { getManagedSprite, listManagedSprites } from '#integrations/sprites';

import { PairingSecret } from '#utilities/pairing-secret';

import { CommandFault } from './errors.js';

import { summarizeMachine } from './machine.js';
import { promptUnavailableDetail } from './operation.js';
import { assessReadiness } from './readiness.js';

import type { SpritesClient, Sprite } from '@fly/sprites';

import type { CommandResult } from '#command';
import type { CommandRequest, Interaction } from '#command/contracts';
import type { DoctorData } from '#command/data';

/**
 * resolves a machine from current provider state, prompting only when permitted
 * @param client authenticated provider client
 * @param requestedName exact machine name when supplied
 * @param interaction optional inline machine selector
 * @returns the freshly fetched and ownership-checked Sprite
 */
export async function selectManagedMachine(
  client: SpritesClient,
  requestedName: string | undefined,
  interaction?: Interaction,
): Promise<Sprite> {
  if (requestedName) {
    return getManagedSprite(client, requestedName);
  }
  if (!interaction) {
    throw new CommandFault({
      code: 'INPUT',
      message: [
        'Workstation name is required in non-interactive mode',
        promptUnavailableDetail(),
      ]
        .filter(Boolean)
        .join('. '),
    });
  }
  const machines = await listManagedSprites(client);
  if (machines.length === 0) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: 'No managed workstations found',
    });
  }
  const selected = await interaction.select(
    { message: 'Select a workstation' },
    machines.map((machine) => ({
      value: machine.name,
      label: machine.name,
      description: `${machine.status ?? 'unknown'} · ${machine.id ?? 'unknown ID'}`,
    })),
  );

  return getManagedSprite(client, selected);
}

/**
 * lists only current managed Sprites without opening guest sessions
 * @param client authenticated provider client
 * @returns current control-plane summaries
 */
export async function listWorkstations(
  client: SpritesClient,
): Promise<CommandResult> {
  const sprites = await listManagedSprites(client);

  return {
    command: 'list',
    ok: true,
    data: { machines: sprites.map((sprite) => summarizeMachine(sprite)) },
  };
}

/**
 * shows current control-plane details; guest inspection and pairing are explicit actions
 * @param request parsed show options and optional machine name
 * @param client authenticated provider client
 * @param interaction optional inline machine selector
 * @returns control-plane details and any explicitly requested action result
 */
export async function showWorkstation(
  request: CommandRequest,
  client: SpritesClient,
  interaction?: Interaction,
): Promise<CommandResult> {
  const sprite = await selectManagedMachine(
    client,
    request.machine,
    interaction,
  );
  const options = request.options;
  const inspected = options.inspect
    ? await inspectGuest(
        sprite,
        interaction ? (update) => interaction.progress(update) : undefined,
      )
    : undefined;
  const pairing = options.withT3PairCode ? await pairT3(sprite) : undefined;

  return {
    command: 'show',
    ok: true,
    data: {
      machine: summarizeMachine(
        sprite,
        pairing ? new PairingSecret({ token: pairing.token }) : undefined,
      ),
      ...(inspected
        ? {
            inspection: { ...inspected, readiness: assessReadiness(inspected) },
          }
        : {}),
      ...(pairing
        ? {
            pairing: {
              status: 'created' as const,
              expiresAt: pairing.expiresAt,
              token: new PairingSecret({ token: pairing.token }),
            },
          }
        : {}),
    },
  };
}

/**
 * performs one bounded current guest readiness inspection
 * @param client authenticated provider client
 * @param requestedName exact machine name when supplied
 * @param interaction optional inline machine selector
 * @returns current guest readiness and non-secret configuration status
 */
export async function doctorWorkstation(
  client: SpritesClient,
  requestedName: string | undefined,
  interaction?: Interaction,
): Promise<CommandResult> {
  const sprite = await selectManagedMachine(client, requestedName, interaction);
  const inspection = await inspectGuest(
    sprite,
    interaction ? (update) => interaction.progress(update) : undefined,
  );
  const { ready, failures, skipped, probeFailures } =
    assessReadiness(inspection);

  const data: DoctorData = {
    machine: summarizeMachine(sprite),
    currentReadiness: {
      ready,
      failures,
      skipped,
      probeFailures,
      tailscale: inspection.tailscale,
      hub: inspection.hub,
      native: inspection.native,
      services: inspection.services.map((service) => ({
        name: service.name,
        state: service.state?.status,
      })),
      manifest: inspection.manifest,
    },
  };

  return ready
    ? { command: 'doctor', ok: true, data }
    : {
        command: 'doctor',
        ok: false,
        data,
        error: {
          code: 'PREFLIGHT',
          message: 'Current workstation readiness check failed',
          machine: sprite.name,
          machineId: sprite.id,
        },
      };
}
