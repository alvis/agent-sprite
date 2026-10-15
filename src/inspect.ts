import { pairAgent } from '#core/services';
import { inspectGuest, readGuestManifest } from '#integrations/guest/runtime';

import { PairingSecret } from '#utilities/pairing-secret';

import { CommandFault, commandError } from './errors.js';

import { summarizeMachine } from './machine.js';
import { promptUnavailableDetail } from './operation.js';
import { assessReadiness } from './readiness.js';

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

/**
 * resolves a machine from current provider state, prompting only when permitted
 * @param provider authenticated provider driver
 * @param requestedName exact machine name when supplied
 * @param interaction optional inline machine selector
 * @returns the freshly fetched and ownership-checked workstation
 */
export async function selectManagedMachine(
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

    return {
      machines: workstations.map((workstation) => ({
        ...summarizeMachine(workstation),
        provider: entry.id,
      })),
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
  const workstation = await selectManagedMachine(
    provider,
    request.machine,
    interaction,
  );
  const options = request.options;
  const inspected = options.inspect
    ? await inspectGuest(
        await provider.openGuest(workstation),
        interaction ? (update) => interaction.progress(update) : undefined,
      )
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
  const workstation = await selectManagedMachine(
    provider,
    requestedName,
    interaction,
  );
  const inspection = await inspectGuest(
    await provider.openGuest(workstation),
    interaction ? (update) => interaction.progress(update) : undefined,
  );
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
      manifest: inspection.manifest,
      governor: inspection.governor,
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
  const { profile } = await readGuestManifest(guest);

  return pairAgent(guest, profile.agent);
}
