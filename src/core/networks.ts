import { catalog } from './catalog';

import type { NetworkDriver } from '#drivers/networks/contracts';

import type { NetworkId } from './catalog';

/** a registered network driver, whatever it declares */
export type RegisteredNetwork = NetworkDriver<NetworkId>;

/** a network that takes caller-side inputs */
export type NetworkWithInputs = RegisteredNetwork &
  Required<Pick<RegisteredNetwork, 'inputs'>>;

/** a network that runs a daemon in the guest */
export type NetworkWithDaemon = RegisteredNetwork &
  Required<Pick<RegisteredNetwork, 'daemon'>>;

/**
 * lists the networks that declare caller-side inputs, whether or not they run
 * a daemon or install a tool
 * @param drivers network drivers to filter, the registered networks by default
 * @returns network drivers in registration order, whether or not a workstation selects them
 */
export function networksWithInputs(
  drivers: readonly RegisteredNetwork[] = Object.values(catalog.networks),
): NetworkWithInputs[] {
  return drivers.filter(
    (driver): driver is NetworkWithInputs => driver.inputs !== undefined,
  );
}

/**
 * lists the networks that declare a daemon, whether or not they take inputs
 * or install a tool
 * @param drivers network drivers to filter, the registered networks by default
 * @returns network drivers in registration order, whether or not a workstation selects them
 */
export function networksWithDaemon(
  drivers: readonly RegisteredNetwork[] = Object.values(catalog.networks),
): NetworkWithDaemon[] {
  return drivers.filter(
    (driver): driver is NetworkWithDaemon => driver.daemon !== undefined,
  );
}

/**
 * resolves the driver of a selected network
 * @param id selected network
 * @returns the network driver, whose declared facts say what the network installs, takes and runs
 */
export function networkDriver(id: NetworkId): RegisteredNetwork {
  return catalog.networks[id];
}

/**
 * lists every registered network id in catalog order
 * @returns the ids of all networks
 */
export function networkIds(): NetworkId[] {
  return Object.values(catalog.networks).map(({ id }) => id);
}

/**
 * tells whether a value names a registered network
 * @param value candidate network id
 * @returns true for a registered network id
 */
export function isNetworkId(value: string): value is NetworkId {
  return Object.hasOwn(catalog.networks, value);
}
