import { catalog } from './catalog.js';

import type { ProviderDriver } from '#drivers/contracts';

import type { ProviderId } from './catalog.js';

/**
 * binds a provider to its management credential and to the agent services a
 * provider may stop and restore while replacing a service they depend on
 * @param id selected provider identifier
 * @param credential provider management credential kept on this computer
 * @returns the bound provider
 */
export function bindProvider(
  id: ProviderId,
  credential: string,
): ProviderDriver<ProviderId> {
  return catalog.providers[id].authenticate({
    credential,
    restorableServices: Object.values(catalog.agents).map(
      ({ service }) => service.name,
    ),
  });
}
