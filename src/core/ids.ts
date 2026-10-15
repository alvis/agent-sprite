import { catalog } from './catalog.js';

import type { AgentId, ProviderId } from './catalog.js';

/**
 * lists every registered provider id in catalog order
 * @returns the ids of all workstation providers
 */
export function providerIds(): ProviderId[] {
  return Object.values(catalog.providers).map(({ id }) => id);
}

/**
 * lists every registered ACP agent id in catalog order
 * @returns the ids of all ACP agents
 */
export function agentIds(): AgentId[] {
  return Object.values(catalog.agents).map(({ id }) => id);
}

/**
 * lists the ACP agents that can issue pairing codes
 * @returns pairing-capable agent ids
 */
export function pairingAgentIds(): AgentId[] {
  return Object.values(catalog.agents)
    .filter(({ supportsPairing }) => supportsPairing)
    .map(({ id }) => id);
}

/**
 * lists the release channels any registered ACP agent declares
 * @returns each declared channel id once, in catalog order
 */
export function releaseChannelIds(): string[] {
  return [
    ...new Set(
      Object.values(catalog.agents).flatMap(
        ({ releaseChannels }) =>
          releaseChannels?.channels.map(({ id }) => id) ?? [],
      ),
    ),
  ];
}
