import { governorJobs, governorServices } from '#adapters/guest/governor';
import { cronService } from '#adapters/guest/services/cron';

import { UPDATE_JOB } from '#adapters/guest/updates';

import type { ProviderDriver, NetworkDriver } from '#application/ports/drivers';
import type { ProviderCapabilities } from '#domain/declarations';
import type { EnvironmentNetwork } from '#domain/observations/environment';
import type { ServiceDefinition, PeriodicJob } from '#domain/services';

/**
 * lists the services environment.json records for the backend to run: cron,
 * which runs the periodic jobs, the governor's awake relay where the backend
 * has a machine log, then the network's daemon, then the agent's service,
 * which waits for the daemon
 * @param agent the agent's service, its needs naming the daemon already
 * @param provider the provider's service backend
 * @param daemon the selected network's daemon; absent when it runs none
 * @returns the services, each after those it needs
 */
export function guestServices(
  agent: ServiceDefinition,
  provider: Pick<ProviderDriver, 'serviceBackend'>,
  daemon?: ServiceDefinition,
): ServiceDefinition[] {
  return [
    cronService,
    ...governorServices(provider),
    ...(daemon ? [daemon] : []),
    agent,
  ];
}

/**
 * lists the jobs environment.json records for cron to run: the hourly update
 * gate, then a governed provider's per-minute governor tick
 * @param capabilities whether the provider governs its keep-awake
 * @returns the jobs, in the order cron lists them
 */
export function guestJobs(
  capabilities: Pick<ProviderCapabilities, 'keepAwakeMode'>,
): PeriodicJob[] {
  return [UPDATE_JOB, ...governorJobs(capabilities)];
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
