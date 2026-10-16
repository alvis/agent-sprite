import { catalog } from '#core/catalog';
import { providerIds } from '#core/ids';
import { prerequisiteDetails, providerPreflight } from '#core/preflight';
import { providersHolding } from '#core/provider-lookup';
import { bindProvider } from '#core/providers';
import { CommandFault } from '#errors';
import { resolveProviderCredential } from '#input/provider-credential';

import type { CommandRequest, Interaction } from '#command/contracts';
import type { ProviderId } from '#core/catalog';
import type { ProviderCredential } from '#input/provider-credential';
import type { ProviderAvailability } from '#inspect';

/**
 * notes that a provider's workstations could not be listed because it has no credential
 * @param id provider without a credential
 * @returns the provider as unavailable with unknown workstation status, naming the credential that would list them
 */
export function skippedProvider(id: ProviderId): ProviderAvailability {
  const { credential } = catalog.providers[id].prerequisites;

  return {
    id,
    code: 'INPUT',
    reason: `workstation status unknown, no ${credential.label} was found; supply one in ${credential.environment}, or with --provider ${id} --provider-token-source, to list its workstations`,
  };
}

/**
 * finds the provider that holds the requested workstation when the caller
 * named no provider, by asking every provider whose credential is ready
 * @param request parsed command and optional workstation name
 * @param interaction optional provider selector for a nameless request
 * @returns the holding provider, or nothing when the default provider should answer
 * @throws {CommandFault} when several providers hold the workstation and the
 * caller cannot choose, or when no provider holds it and one could not be asked
 */
export async function locateProvider(
  request: CommandRequest,
  interaction?: Interaction,
): Promise<ProviderId | undefined> {
  const { options, machine } = request;
  // an explicit credential source names one provider's credential only
  if (options.providerTokenSource) {
    return undefined;
  }
  const found = await Promise.all(
    providerIds().map(async (id) => ({
      id,
      credential: await resolveProviderCredential(options, id),
    })),
  );
  const ready = (
    await providerAvailability(
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
 * @param available providers with a resolved credential
 * @returns bound providers, or the reason each one is unavailable
 */
export async function providerAvailability(
  available: ReadonlyArray<{ id: ProviderId; credential: ProviderCredential }>,
): Promise<ProviderAvailability[]> {
  return Promise.all(
    available.map(async ({ id, credential }) => {
      const problems = await providerPreflight(id, credential);

      return credential.token && problems.length === 0
        ? { id, driver: bindProvider(id, credential.token) }
        : {
            id,
            code: 'INPUT' as const,
            reason: prerequisiteDetails(problems).join(' '),
          };
    }),
  );
}
