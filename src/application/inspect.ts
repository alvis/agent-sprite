import { pairAgent } from '#application/catalog/services';
import { probeProgress } from '#application/inspection/progress';

import { CommandFault } from '#kernel/faults';

import { promptUnavailableDetail } from '#kernel/operation';
import { PairingSecret } from '#kernel/pairing-secret';

import { commandError } from './failures';

import { summarizeMachine } from './machine';
import { assessReadiness } from './readiness';

import type { WorkstationCommandParams } from '#application/contracts';
import type {
  DoctorData,
  ListData,
  UnavailableProvider,
} from '#application/data';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { ProviderDriver } from '#application/ports/drivers';
import type { ReleaseSource } from '#application/ports/guest';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { Interaction } from '#application/ports/interaction';
import type { CommandResult } from '#application/result';
import type { AgentPairing } from '#domain/declarations';
import type { ProviderId } from '#domain/ids';
import type { WorkstationRecord } from '#domain/workstation';
import type { CommandErrorCode } from '#kernel/faults';

/** the named inputs of select managed machine */
export interface SelectManagedMachineParams {
  /** authenticated provider driver */
  provider: ProviderDriver;
  /** exact machine name when supplied */
  requestedName: string | undefined;
  /** optional inline machine selector */
  interaction?: Interaction;
  /** where the recorded release is read from */
  release: ReleaseSource;
}

/**
 * resolves a machine from current provider state, prompting only when
 * permitted, and refuses one a newer open-agent release set up
 * @param dependencies the guest mechanics
 * @param params the call's inputs: provider, requestedName, interaction, release
 * @returns the freshly fetched, ownership-checked and supported workstation
 * @throws {CommandFault} when a newer open-agent release set it up
 */
export async function selectManagedMachine(
  dependencies: Pick<ApplicationDependencies, 'guest'>,
  params: SelectManagedMachineParams,
): Promise<WorkstationRecord> {
  const { provider, requestedName } = params;
  const { interaction, release } = params;
  const workstation = await findManagedMachine(
    provider,
    requestedName,
    interaction,
  );
  await dependencies.guest.release.assertSupported(
    provider,
    workstation,
    release,
  );

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
 * @param dependencies the registered drivers, the guest mechanics
 * @param providers providers bound with their credentials, or why they are not
 * @returns merged control-plane summaries and unavailable providers
 */
export async function listWorkstations(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  providers: readonly ProviderAvailability[],
): Promise<CommandResult> {
  const results = await Promise.all(
    providers.map(async (entry) => listProvider(dependencies, entry)),
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
 * @param dependencies the registered drivers, the guest mechanics
 * @param entry bound provider or its unavailability reason
 * @returns the provider's machines, or why it is unavailable
 */
async function listProvider(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
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
        const newerRelease =
          dependencies.guest.release.newerMetadata(workstation);

        return {
          ...summarizeMachine(dependencies, workstation),
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
 * @param dependencies the registered drivers, the guest mechanics
 * @param params the call's inputs: request, provider, interaction
 * @returns control-plane details and any explicitly requested action result
 */
export async function showWorkstation(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  params: WorkstationCommandParams,
): Promise<CommandResult> {
  const { request, provider, interaction } = params;
  const options = request.options;
  // a control-plane summary never wakes the guest; an inspection or pairing does
  const workstation = await selectManagedMachine(dependencies, {
    provider,
    requestedName: request.machine,
    interaction,
    release: options.inspect || options.withPairCode ? 'guest' : 'metadata',
  });
  const inspected = options.inspect
    ? await dependencies.guest.inspection.inspect(
        await provider.openGuest(workstation),
        {
          onProbe: probeProgress(interaction?.progress.bind(interaction)),
          provider,
        },
      )
    : undefined;
  const pairing = options.withPairCode
    ? await pairRecordedAgent(
        dependencies,
        await provider.openGuest(workstation),
      )
    : undefined;

  return {
    command: 'show',
    ok: true,
    data: {
      machine: summarizeMachine(
        dependencies,
        workstation,
        pairing ? new PairingSecret({ token: pairing.token }) : undefined,
      ),
      ...(inspected
        ? {
            inspection: {
              ...inspected,
              readiness: assessReadiness(dependencies, inspected),
            },
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

/** the named inputs of doctor workstation */
export interface DoctorWorkstationParams {
  /** authenticated provider driver */
  provider: ProviderDriver;
  /** exact machine name when supplied */
  requestedName: string | undefined;
  /** optional inline machine selector */
  interaction?: Interaction;
}

/**
 * performs one bounded current guest readiness inspection
 * @param dependencies the registered drivers, the guest mechanics
 * @param params the call's inputs: provider, requestedName, interaction
 * @returns current guest readiness and non-secret configuration status
 */
export async function doctorWorkstation(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  params: DoctorWorkstationParams,
): Promise<CommandResult> {
  const { provider, requestedName, interaction } = params;
  const workstation = await selectManagedMachine(dependencies, {
    provider,
    requestedName,
    interaction,
    release: 'guest',
  });
  const inspection = await dependencies.guest.inspection.inspect(
    await provider.openGuest(workstation),
    {
      onProbe: probeProgress(interaction?.progress.bind(interaction)),
      provider,
    },
  );
  const { ready, failures, skipped, probeFailures } = assessReadiness(
    dependencies,
    inspection,
  );

  const data: DoctorData = {
    machine: summarizeMachine(dependencies, workstation),
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
 * @param dependencies the registered drivers, the guest mechanics
 * @param guest guest channel of the selected workstation
 * @returns the pairing credential
 */
async function pairRecordedAgent(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'guest'>,
  guest: GuestChannel,
): Promise<AgentPairing> {
  const { profile } = await dependencies.guest.environment.read(guest);

  return pairAgent(dependencies.registry, guest, profile.agent);
}
