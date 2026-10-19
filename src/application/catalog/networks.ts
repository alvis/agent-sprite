import type { DriverRegistry, NetworkDriver } from '#application/ports/drivers';
import type { NetworkId } from '#domain/ids';

/** a registered network driver, whatever it declares */
export type RegisteredNetwork = NetworkDriver<NetworkId>;

/** a network that takes caller-side inputs */
export type NetworkWithInputs = RegisteredNetwork &
  Required<Pick<RegisteredNetwork, 'inputs'>>;

/** a network that runs a daemon in the guest */
export type NetworkWithDaemon = RegisteredNetwork &
  Required<Pick<RegisteredNetwork, 'daemon'>>;

/** the network drivers a lookup reads */
interface NetworkCatalog {
  /** network drivers keyed by identifier, in registration order */
  networks: Readonly<Record<string, RegisteredNetwork>>;
}

/**
 * lists the networks that declare caller-side inputs, whether or not they run
 * a daemon or install a tool
 * @param registry every registered driver
 * @returns network drivers in registration order, whether or not a workstation selects them
 */
export function networksWithInputs(
  registry: NetworkCatalog,
): NetworkWithInputs[] {
  return Object.values(registry.networks).filter(
    (driver): driver is NetworkWithInputs => driver.inputs !== undefined,
  );
}

/**
 * lists the networks that declare a daemon, whether or not they take inputs
 * or install a tool
 * @param registry every registered driver
 * @returns network drivers in registration order, whether or not a workstation selects them
 */
export function networksWithDaemon(
  registry: NetworkCatalog,
): NetworkWithDaemon[] {
  return Object.values(registry.networks).filter(
    (driver): driver is NetworkWithDaemon => driver.daemon !== undefined,
  );
}

/**
 * resolves the driver of a selected network
 * @param registry every registered driver
 * @param id selected network
 * @returns the network driver, whose declared facts say what the network installs, takes and runs
 */
export function networkDriver(
  registry: Pick<DriverRegistry, 'networks'>,
  id: NetworkId,
): RegisteredNetwork {
  return registry.networks[id];
}
