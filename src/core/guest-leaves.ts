import { t3GuestLeaf } from '#drivers/agents/t3/guest-leaf';
import { claudeGuestLeaf } from '#drivers/harnesses/claude/guest-leaf';
import { codexGuestLeaf } from '#drivers/harnesses/codex/guest-leaf';
import { tailscaleGuestLeaf } from '#drivers/networks/tailscale/guest-leaf';
import { flyMachineGuestLeaf } from '#drivers/providers/fly-machine/guest-leaf';
import { spriteGuestLeaf } from '#drivers/providers/sprite/guest-leaf';
import { cliproxyapiGuestLeaf } from '#drivers/shared/cliproxyapi/guest-leaf';

import type {
  AgentGuestLeaf,
  HarnessGuestLeaf,
  NetworkGuestLeaf,
  ProviderGuestLeaf,
  SharedGuestLeaf,
} from '#drivers/contracts';

// the payload pipeline reads these facts before any driver loads, because the
// driver catalog depends on the pipeline; this registry therefore imports only
// each driver's guest leaf, and the catalog checks its keys against these

/** the guest facts of every driver folder, keyed by kind and driver id */
interface GuestLeafRegistry {
  /** providers, keyed by provider id */
  providers: Readonly<Record<string, ProviderGuestLeaf>>;
  /** harnesses, keyed by harness id */
  harnesses: Readonly<Record<string, HarnessGuestLeaf>>;
  /** ACP agents, keyed by agent id */
  agents: Readonly<Record<string, AgentGuestLeaf>>;
  /** networks that install a tool, keyed by network id */
  networks: Readonly<Record<string, NetworkGuestLeaf>>;
  /** components several drivers share, keyed by component folder */
  shared: Readonly<Record<string, SharedGuestLeaf>>;
}

/** the guest facts of every registered driver and shared component */
export const GUEST_LEAVES = {
  providers: {
    'sprite': spriteGuestLeaf,
    'fly-machine': flyMachineGuestLeaf,
  },
  harnesses: { claude: claudeGuestLeaf, codex: codexGuestLeaf },
  agents: { t3: t3GuestLeaf },
  networks: { tailscale: tailscaleGuestLeaf },
  shared: { cliproxyapi: cliproxyapiGuestLeaf },
} as const satisfies GuestLeafRegistry;
