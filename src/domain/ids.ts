import type { ProductDeclarations } from '#domain/declarations';

/** every registered provider driver, in catalog order */
export const PROVIDER_IDS = ['sprite', 'fly-machine'] as const;

/** every registered harness driver, in catalog order */
export const HARNESS_IDS = ['claude', 'codex'] as const;

/** every registered ACP agent driver, in catalog order */
export const AGENT_IDS = ['t3'] as const;

/** every registered network driver, in catalog order */
export const NETWORK_IDS = ['none', 'tailscale'] as const;

/** every registered model-gateway driver, in catalog order */
export const GATEWAY_IDS = ['cliproxyapi'] as const;

/** identifier of a registered provider driver */
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** identifier of a registered harness driver */
export type HarnessId = (typeof HARNESS_IDS)[number];

/** identifier of a registered ACP agent driver */
export type AgentId = (typeof AGENT_IDS)[number];

/** identifier of a registered network driver */
export type NetworkId = (typeof NETWORK_IDS)[number];

/** identifier of a registered model-gateway driver */
export type GatewayId = (typeof GATEWAY_IDS)[number];

/** the kinds of driver; a workstation selects the first four, and routes through a gateway only when asked */
export type DriverKind =
  'providers' | 'harnesses' | 'agents' | 'networks' | 'gateways';

/** registered identifiers, keyed by driver kind */
interface DriverIds {
  providers: ProviderId;
  harnesses: HarnessId;
  agents: AgentId;
  networks: NetworkId;
  gateways: GatewayId;
}

/** identifier of a registered driver of one kind, or of any kind */
export type DriverId<Kind extends DriverKind = DriverKind> = DriverIds[Kind];

/** the network a workstation selects when it joins no private network */
export const NO_NETWORK = 'none' satisfies NetworkId;

/**
 * lists the ACP agents that can issue pairing codes
 * @param declarations the data every registered driver declares
 * @returns pairing-capable agent ids
 */
export function pairingAgentIds(declarations: ProductDeclarations): AgentId[] {
  return Object.values(declarations.agents)
    .filter(({ supportsPairing }) => supportsPairing)
    .map(({ id }) => id);
}

/**
 * lists the release channels any registered ACP agent declares
 * @param declarations the data every registered driver declares
 * @returns each declared channel id once, in catalog order
 */
export function releaseChannelIds(declarations: ProductDeclarations): string[] {
  return [
    ...new Set(
      Object.values(declarations.agents).flatMap(
        ({ releaseChannels }) =>
          releaseChannels?.channels.map(({ id }) => id) ?? [],
      ),
    ),
  ];
}
