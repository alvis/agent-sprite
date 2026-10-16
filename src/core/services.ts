import { CommandFault } from '#errors';
import { cronService } from '#services/cron';

import { catalog } from './catalog';

import type { AgentPairing } from '#drivers/contracts';
import type { GuestChannel, ServiceDefinition } from '#drivers/guest-channel';

import type { AgentId, NetworkId } from './catalog';

/** how human output names the maintenance service */
const MAINTENANCE_LABEL = 'Maintenance scheduler';

/**
 * lists the daemon the agent service depends on for a network
 * @param network selected network identifier
 * @returns the daemon, or undefined when the network runs none
 */
export function networkDaemon(
  network: NetworkId,
): ServiceDefinition | undefined {
  return catalog.networks[network].daemon;
}

/**
 * builds the agent service, depending on the daemon of the selected network
 * @param selection selected agent and network identifiers
 * @param selection.agent selected ACP agent
 * @param selection.network selected network
 * @returns the service definition core registers
 */
export function agentService(selection: {
  agent: AgentId;
  network: NetworkId;
}): ServiceDefinition {
  return dependOnDaemon(
    catalog.agents[selection.agent].service,
    networkDaemon(selection.network),
  );
}

/**
 * adds a network daemon to what a service already waits for, once
 * @param service service with its own dependencies
 * @param daemon daemon the selected network runs, if any
 * @returns the service waiting for its own dependencies and the daemon
 */
export function dependOnDaemon(
  service: ServiceDefinition,
  daemon: ServiceDefinition | undefined,
): ServiceDefinition {
  return {
    ...service,
    needs: [...new Set([...service.needs, ...(daemon ? [daemon.name] : [])])],
  };
}

/**
 * reads the port the provider publishes for an agent
 * @param agent selected agent identifier
 * @returns the port the agent service listens on
 * @throws {CommandFault} when the agent publishes no port
 */
export function agentPort(agent: AgentId): number {
  const { httpPort } = catalog.agents[agent].service;
  if (httpPort === undefined) {
    throw new CommandFault({
      code: 'UNEXPECTED',
      message: `Agent ${agent} publishes no port`,
    });
  }

  return httpPort;
}

/**
 * issues a pairing code through the agent
 * @param guest guest channel of the workstation
 * @param agent selected agent identifier
 * @returns the pairing credential
 * @throws {CommandFault} when the agent cannot pair
 */
export async function pairAgent(
  guest: GuestChannel,
  agent: AgentId,
): Promise<AgentPairing> {
  const driver = catalog.agents[agent];
  if (!driver.pair) {
    throw new CommandFault({
      code: 'UNEXPECTED',
      message: `Agent ${agent} cannot issue pairing codes`,
    });
  }

  return driver.pair(guest);
}

/**
 * labels every managed service for human output
 * @returns display names keyed by service name
 */
export function serviceLabels(): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.values(catalog.agents).map(({ service, displayName }) => [
        service.name,
        displayName,
      ]),
    ),
    ...Object.fromEntries(
      Object.values(catalog.networks).flatMap(({ daemon, displayName }) =>
        daemon ? [[daemon.name, displayName]] : [],
      ),
    ),
    [cronService.name]: MAINTENANCE_LABEL,
  };
}
