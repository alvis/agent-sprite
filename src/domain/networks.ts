import { NETWORK_IDS } from '#domain/ids';

import type { NetworkId } from '#domain/ids';

/**
 * lists every registered network id in catalog order
 * @returns the ids of all networks
 */
export function networkIds(): NetworkId[] {
  return [...NETWORK_IDS];
}

/**
 * tells whether a value names a registered network
 * @param value candidate network id
 * @returns true for a registered network id
 */
export function isNetworkId(value: string): value is NetworkId {
  return NETWORK_IDS.some((id) => id === value);
}
