import { t3 as t3Agent } from '#drivers/agents/t3/index';
import { claude as claudeHarness } from '#drivers/harnesses/claude/index';
import { codex as codexHarness } from '#drivers/harnesses/codex/index';
import { none as noneNetwork } from '#drivers/networks/none/index';
import { tailscale as tailscaleNetwork } from '#drivers/networks/tailscale/index';
import { flyMachine as flyMachineProvider } from '#drivers/providers/fly-machine/index';
import { sprite as spriteProvider } from '#drivers/providers/sprite/index';

import type { T3Environment } from '#drivers/agents/t3/index';
import type {
  AgentDriver,
  DriverKind,
  NetworkDriver,
  ProviderDriver,
} from '#drivers/contracts';
import type { TailnetStatus } from '#drivers/networks/tailscale/index';

/** identifier of a registered provider driver */
export type ProviderId = keyof typeof providers;

/** identifier of a registered harness driver */
export type HarnessId = keyof typeof harnesses;

/** identifier of a registered ACP agent driver */
export type AgentId = keyof typeof agents;

/** identifier of a registered network driver */
export type NetworkId = keyof typeof networks;

/** identifier of a registered driver of one kind */
export type DriverId<Kind extends DriverKind> = keyof (typeof catalog)[Kind];

// each entry is a typed driver (or declaration) of its kind, so the derived
// identifier unions stay exactly the registered keys
const sprite: ProviderDriver<'sprite'> = spriteProvider;

const flyMachine: ProviderDriver<'fly-machine'> = flyMachineProvider;

const claude = claudeHarness;

const codex = codexHarness;

const providers = { sprite, 'fly-machine': flyMachine } as const;

const harnesses = { claude, codex } as const;

const t3: AgentDriver<'t3', HarnessId, T3Environment> = t3Agent;

const none: NetworkDriver<'none'> = noneNetwork;

const tailscale: NetworkDriver<'tailscale', TailnetStatus> = tailscaleNetwork;

const agents = { t3 } as const;

const networks = { none, tailscale } as const;

/** the network a workstation selects when it joins no private network */
export const NO_NETWORK = none.id;

/** compile-time list of every available driver, keyed by kind and id */
export const catalog = { providers, harnesses, agents, networks } as const;

/** what any registered ACP agent reports about its running service */
export type RegisteredAgentEnvironment = NonNullable<
  Awaited<ReturnType<(typeof agents)[AgentId]['inspectEnvironment']>>
>;

/** default driver choices, keyed by the input that selects among them */
interface DefaultSelection {
  /** default provider */
  provider: ProviderId;
  /** default ACP agent */
  agent: AgentId;
  /** default harnesses */
  harnesses: readonly HarnessId[];
  /** network when neither a choice nor a network's own inputs select one */
  network: NetworkId;
}

/** drivers selected when nothing else chooses them; reproduces today's workstation */
export const DEFAULT_SELECTION = {
  provider: 'sprite',
  agent: 't3',
  harnesses: ['claude', 'codex'],
  network: NO_NETWORK,
} as const satisfies DefaultSelection;
