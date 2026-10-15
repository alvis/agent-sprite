import { cronService } from '#os/services/cron';

import type { ServiceDefinition } from '#drivers/guest-channel';
import type { NetworkDriver } from '#drivers/networks/contracts';

import type { EnvironmentNetwork } from './environment.js';

/**
 * lists the services environment.json records for the backend to run: cron,
 * which runs the periodic jobs, then the network's daemon, then the agent's
 * service, which waits for the daemon
 * @param agent the agent's service, its needs naming the daemon already
 * @param daemon the selected network's daemon; absent when it runs none
 * @returns the services, each after those it needs
 */
export function guestServices(
  agent: ServiceDefinition,
  daemon?: ServiceDefinition,
): ServiceDefinition[] {
  return [cronService, ...(daemon ? [daemon] : []), agent];
}

/**
 * records the selected network's daemon and where its launcher keeps the
 * daemon's state, socket and tunnel
 * @param network the selected network driver
 * @returns the network's launch facts; null when it runs no daemon
 * @throws {Error} when the network runs a daemon without a launcher, or a launcher without a daemon
 */
export function environmentNetwork(
  network: Pick<NetworkDriver, 'id' | 'daemon' | 'launcher'>,
): EnvironmentNetwork | null {
  const { id, daemon, launcher } = network;
  if (!daemon !== !launcher) {
    throw new Error(`Network ${id} declares a daemon without its launcher`);
  }
  if (!daemon || !launcher) {
    return null;
  }
  const { stateDirectory, socket, tun } = launcher;

  return { id, daemon: daemon.name, launcher: { stateDirectory, socket, tun } };
}
