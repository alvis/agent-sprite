import { pairAgent } from '#core/services';
import { readGuestEnvironment } from '#integrations/guest/environment/store';
import {
  assertSupportedRelease,
  newerMetadataRelease,
} from '#integrations/guest/release-guard';
import { inspectGuest } from '#integrations/guest/runtime';

import { PairingSecret } from '#utilities/pairing-secret';

import { CommandFault, commandError } from './errors';

import { summarizeMachine } from './machine';
import { promptUnavailableDetail } from './operation';
import { assessReadiness } from './readiness';

import type { CommandResult } from '#command';
import type {
  CommandErrorCode,
  CommandRequest,
  Interaction,
} from '#command/contracts';
import type { DoctorData, ListData, UnavailableProvider } from '#command/data';
import type { ProviderId } from '#core/catalog';
import type {
  AgentPairing,
  ProviderDriver,
  WorkstationRecord,
} from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';
import type { ReleaseSource } from '#integrations/guest/release-guard';

/**
 * resolves a machine from current provider state, prompting only when
 * permitted, and refuses one a newer open-agent release set up
 * @param provider authenticated provider driver
 * @param requestedName exact machine name when supplied
 * @param selection the inline machine selector and where the release that set the machine up is read from
 * @param selection.interaction optional inline machine selector
 * @param selection.release where the recorded release is read from
 * @returns the freshly fetched, ownership-checked and supported workstation
 * @throws {CommandFault} when a newer open-agent release set it up
 */
export async function selectManagedMachine(
  provider: ProviderDriver,
  requestedName: string | undefined,
  selection: { interaction?: Interaction; release: ReleaseSource },
): Promise<WorkstationRecord> {
  const { interaction, release } = selection;
  const workstation = await findManagedMachine(
    provider,
    requestedName,
    interaction,
  );
  await assertSupportedRelease(provider, workstation, release);

  return workstation;
}

/**
 * resolves a machine from current provider state, prompting only when permitted
 * @param provider authenticated provider driver
 * @param requestedName exact machine name when supplied
 * @param interaction optional inline machine selector
 * @returns the freshly fetched and ownership-checked workstation
 */
async function findManagedMachine(
  provider: ProviderDriver,
  requestedName: string | undefined,
  interaction?: Interaction,
): Promise<WorkstationRecord> {
  if (requestedName) {
    return provider.get(requestedName);
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
  const machines = await provider.list();
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
      description: `${machine.state} · ${machine.id || 'unknown ID'}`,
    })),
  );

  return provider.get(selected);
}

/** a provider bound for listing, or the reason it cannot be queried */
export type ProviderAvailability =
  | { id: ProviderId; driver: ProviderDriver }
  | { id: ProviderId; code: CommandErrorCode; reason: string };

/**
 * lists current managed workstations across every available provider without
 * opening guest sessions; a provider that fails is reported as unavailable
 * @param providers providers bound with their credentials, or why they are not
 * @returns merged control-plane summaries and unavailable providers
 */
export async function listWorkstations(
  providers: readonly ProviderAvailability[],
): Promise<CommandResult> {
  const results = await Promise.all(
    providers.map(async (entry) => listProvider(entry)),
  );
  const unavailable = results.flatMap((result) =>
    'reason' in result ? [result] : [],
  );
  const machines = results.flatMap((result) =>
    'machines' in result ? result.machines : [],
  );
  if (machines.length === 0 && unavailable.length === results.length) {
    const codes = new Set(unavailable.map(({ code }) => code));
    const [shared] = codes;

    return {
      command: 'list',
      ok: false,
      error: {
        code: codes.size === 1 && shared ? shared : 'PROVIDER',
        message: 'No provider could be queried',
        details: unavailable.map(
          ({ provider, reason }) => `${provider}: ${reason}`,
        ),
      },
    };
  }

  return { command: 'list', ok: true, data: { machines, unavailable } };
}

/**
 * queries one provider, turning its failure into an unavailable entry
 * @param entry bound provider or its unavailability reason
 * @returns the provider's machines, or why it is unavailable
 */
async function listProvider(
  entry: ProviderAvailability,
): Promise<{ machines: ListData['machines'] } | UnavailableProvider> {
  if ('reason' in entry) {
    return { provider: entry.id, code: entry.code, reason: entry.reason };
  }
  try {
    const workstations = await entry.driver.list();

    // listing never wakes a guest, so only the release metadata records is
    // read; a newer workstation is marked, and every action on it still refuses
    return {
      machines: workstations.map((workstation) => {
        const newerRelease = newerMetadataRelease(workstation);

        return {
          ...summarizeMachine(workstation),
          provider: entry.id,
          ...(newerRelease ? { newerRelease } : {}),
        };
      }),
    };
  } catch (error) {
    const { code, message } = commandError(error);

    return { provider: entry.id, code, reason: message };
  }
}

/**
 * shows current control-plane details; guest inspection and pairing are explicit actions
 * @param request parsed show options and optional machine name
 * @param provider authenticated provider driver
 * @param interaction optional inline machine selector
 * @returns control-plane details and any explicitly requested action result
 */
export async function showWorkstation(
  request: CommandRequest,
  provider: ProviderDriver,
  interaction?: Interaction,
): Promise<CommandResult> {
  const options = request.options;
  // a control-plane summary never wakes the guest; an inspection or pairing does
  const workstation = await selectManagedMachine(provider, request.machine, {
    interaction,
    release: options.inspect || options.withPairCode ? 'guest' : 'metadata',
  });
  const inspected = options.inspect
    ? await inspectGuest(await provider.openGuest(workstation), {
        progress: interaction
          ? (update) => interaction.progress(update)
          : undefined,
        provider,
      })
    : undefined;
  const pairing = options.withPairCode
    ? await pairRecordedAgent(await provider.openGuest(workstation))
    : undefined;

  return {
    command: 'show',
    ok: true,
    data: {
      machine: summarizeMachine(
        workstation,
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
 * @param provider authenticated provider driver
 * @param requestedName exact machine name when supplied
 * @param interaction optional inline machine selector
 * @returns current guest readiness and non-secret configuration status
 */
export async function doctorWorkstation(
  provider: ProviderDriver,
  requestedName: string | undefined,
  interaction?: Interaction,
): Promise<CommandResult> {
  const workstation = await selectManagedMachine(provider, requestedName, {
    interaction,
    release: 'guest',
  });
  const inspection = await inspectGuest(await provider.openGuest(workstation), {
    progress: interaction
      ? (update) => interaction.progress(update)
      : undefined,
    provider,
  });
  const { ready, failures, skipped, probeFailures } =
    assessReadiness(inspection);

  const data: DoctorData = {
    machine: summarizeMachine(workstation),
    currentReadiness: {
      ready,
      failures,
      skipped,
      probeFailures,
      network: inspection.network,
      hub: inspection.hub,
      native: inspection.native,
      services: inspection.services.map((service) => ({
        name: service.name,
        state: service.status,
      })),
      environment: inspection.environment,
      ...(inspection.updates ? { updates: inspection.updates } : {}),
      governor: inspection.governor,
      ...(inspection.boot ? { boot: inspection.boot } : {}),
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
          machine: workstation.name,
          machineId: workstation.id,
        },
      };
}

/**
 * issues a pairing code through the agent the workstation records
 * @param guest guest channel of the selected workstation
 * @returns the pairing credential
 */
async function pairRecordedAgent(guest: GuestChannel): Promise<AgentPairing> {
  const { profile } = await readGuestEnvironment(guest);

  return pairAgent(guest, profile.agent);
}
