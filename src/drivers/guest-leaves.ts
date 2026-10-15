import type { ToolSpec } from '#tools/contracts';

import type {
  AgentDriver,
  GuestPayload,
  HarnessDriver,
  ProviderDriver,
} from './contracts.js';
import type { ReleaseInstallSource } from './install-sources.js';

// each driver folder exports its leaf from `guest-leaf.ts`, which imports
// nothing but the driver's own data, so the payload pipeline can read it
// before the driver catalog loads

/**
 * the guest facts of a provider the payload pipeline needs before any driver
 * loads: its login accounts, the capability axes the idle governor reads, who
 * runs its services, the boot hook it keeps and the awake adapters it
 * deploys
 */
export type ProviderGuestLeaf = Pick<
  ProviderDriver,
  | 'shellAccounts'
  | 'capabilities'
  | 'serviceBackend'
  | 'bootHook'
  | 'awakeAdapter'
  | 'awakeAsset'
>;

/** the guest facts of a harness the payload pipeline needs before any driver loads */
export type HarnessGuestLeaf = Pick<
  HarnessDriver,
  'guest' | 'tools' | 'spawnEnvironment' | 'acpAdapter'
>;

/** the guest facts of an ACP agent the payload pipeline needs before any driver loads */
export interface AgentGuestLeaf<
  HarnessName extends string = string,
> extends Pick<
  AgentDriver,
  'guest' | 'tools' | 'guestPackages' | 'service' | 'releaseChannels'
> {
  /** how the agent names each harness it supports, keyed by exactly the supported harness driver ids */
  harnessNames: Readonly<Record<HarnessName, string>>;
}

/** the guest facts of a network the payload pipeline needs before any driver loads */
export interface NetworkGuestLeaf {
  /** compiled guest modules the network contributes to the deployable payload */
  guest: readonly GuestPayload[];
  /** the tools the network installs while it is selected */
  tools: readonly ToolSpec[];
  /** the release feed and guest module the current guest installer installs the network's tool with */
  releaseFeed: ReleaseInstallSource;
}

/** the guest facts of a component several drivers share */
export interface SharedGuestLeaf {
  /** compiled guest modules the component contributes to the deployable payload */
  guest: readonly GuestPayload[];
}
