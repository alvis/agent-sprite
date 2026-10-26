import { providerPreflight } from '#application/catalog/preflight';
import { providersHolding, bindProvider } from '#application/catalog/providers';
import { resolveProviderCredential } from '#application/input/provider-credential';
import { PROVIDER_IDS } from '#domain/ids';
import { prerequisiteDetails } from '#domain/prerequisites';
import { CommandFault } from '#kernel/faults';

import type { CommandRequest } from '#application/contracts';
import type { ProviderCredential } from '#application/input/provider-credential';
import type { ProviderAvailability } from '#application/inspect';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { Interaction } from '#application/ports/interaction';
import type { ProviderId } from '#domain/ids';

/** a provider with its resolved management credential */
interface AvailableProviderCredential {
  id: ProviderId;
  credential: ProviderCredential;
}

/**
 * notes that a provider's workstations could not be listed because it has no credential
 * @param dependencies the registered drivers
 * @param id provider without a credential
 * @returns the provider as unavailable with unknown workstation status, naming the credential that would list them
 */
export function skippedProvider(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  id: ProviderId,
): ProviderAvailability {
  const { credential } = dependencies.registry.providers[id].prerequisites;

  return {
    id,
    code: 'INPUT',
    reason: `workstation status unknown, no ${credential.label} was found; supply one in ${credential.environment}, or with --provider ${id} --provider-token-source, to list its workstations`,
  };
}

/**
 * finds the provider that holds the requested workstation when the caller
 * named no provider, by asking every provider whose credential is ready
 * @param dependencies the registered drivers, what this computer provides
 * @param request parsed command and optional workstation name
 * @param interaction optional provider selector for a nameless request
 * @returns the holding provider, or nothing when the default provider should answer
 * @throws {CommandFault} when several providers hold the workstation and the
 * caller cannot choose, or when no provider holds it and one could not be asked
 */
export async function locateProvider(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'host'>,
  request: CommandRequest,
  interaction?: Interaction,
): Promise<ProviderId | undefined> {
  const { options, machine } = request;
  // an explicit credential source names one provider's credential only
  if (options.providerTokenSource) {
    return undefined;
  }
  const found = await Promise.all(
    PROVIDER_IDS.map(async (id) => ({
      id,
      credential: await resolveProviderCredential(dependencies, {
        options,
        provider: id,
      }),
    })),
  );
  const ready = (
    await providerAvailability(
      dependencies,
      found.filter(({ credential }) => credential.token),
    )
  ).flatMap((entry) => ('driver' in entry ? [entry] : []));
  if (ready.length < 2) {
    return ready[0]?.id;
  }
  const { holders, failures } = await providersHolding(ready, machine);
  const [only] = holders;
  if (holders.length === 1) {
    return only;
  }
  if (holders.length === 0 && machine && failures.length > 0) {
    throw failures[0];
  }
  if (holders.length > 1) {
    if (machine || !interaction) {
      const subject = machine
        ? `Workstation ${machine} exists`
        : 'Workstations exist';

      throw new CommandFault({
        code: 'INPUT',
        message: `${subject} on several providers (${holders.join(', ')}); pass --provider`,
      });
    }

    return interaction.select(
      { message: 'Select a provider' },
      holders.map((id) => ({ value: id, label: id })),
    );
  }

  return undefined;
}

/**
 * preflights each provider with a credential and binds the ready ones
 * @param dependencies the registered drivers, what this computer provides
 * @param available providers with a resolved credential
 * @returns bound providers, or the reason each one is unavailable
 */
export async function providerAvailability(
  dependencies: Pick<ApplicationDependencies, 'registry' | 'host'>,
  available: readonly AvailableProviderCredential[],
): Promise<ProviderAvailability[]> {
  return Promise.all(
    available.map(async ({ id, credential }) => {
      const problems = await providerPreflight(
        { registry: dependencies.registry, host: dependencies.host },
        id,
        credential,
      );

      return credential.token && problems.length === 0
        ? {
            id,
            driver: bindProvider(dependencies.registry, id, credential.token),
          }
        : {
            id,
            code: 'INPUT' as const,
            reason: prerequisiteDetails(problems).join(' '),
          };
    }),
  );
}
