import { CRON_SERVICE_NAME } from '#domain/services';
import { CommandFault } from '#kernel/faults';

import type { DriverRegistry } from '#application/ports/drivers';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { AgentPairing } from '#domain/declarations';
import type { AgentId } from '#domain/ids';

/** how human output names the maintenance service */
const MAINTENANCE_LABEL = 'Maintenance scheduler';

/**
 * issues a pairing code through the agent
 * @param registry every registered driver
 * @param guest guest channel of the workstation
 * @param agent selected agent identifier
 * @returns the pairing credential
 * @throws {CommandFault} when the agent cannot pair
 */
export async function pairAgent(
  registry: Pick<DriverRegistry, 'agents'>,
  guest: GuestChannel,
  agent: AgentId,
): Promise<AgentPairing> {
  const driver = registry.agents[agent];
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
 * @param registry every registered driver
 * @returns display names keyed by service name
 */
export function serviceLabels(
  registry: Pick<DriverRegistry, 'agents' | 'networks'>,
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.values(registry.agents).map(({ service, displayName }) => [
        service.name,
        displayName,
      ]),
    ),
    ...Object.fromEntries(
      Object.values(registry.networks).flatMap(({ daemon, displayName }) =>
        daemon ? [[daemon.name, displayName]] : [],
      ),
    ),
    [CRON_SERVICE_NAME]: MAINTENANCE_LABEL,
  };
}
