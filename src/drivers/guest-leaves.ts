import type {
  AgentDriver,
  GuestPayload,
  HarnessDriver,
  InstallSpec,
  ProviderDriver,
} from './contracts.js';

// each driver folder exports its leaf from `guest-leaf.ts`, which imports
// nothing but the driver's own data, so the payload pipeline can read it
// before the driver catalog loads

/**
 * the guest facts of a provider the payload pipeline needs before any driver
 * loads: its login accounts, the capability axes the idle governor reads and
 * the awake adapter module it deploys
 */
export type ProviderGuestLeaf = Pick<
  ProviderDriver,
  'shellAccounts' | 'capabilities' | 'awakeAdapter'
>;

/** the guest facts of a harness the payload pipeline needs before any driver loads */
export type HarnessGuestLeaf = Pick<
  HarnessDriver,
  'guest' | 'install' | 'spawnEnvironment' | 'acpAdapter'
>;

/** the guest facts of an ACP agent the payload pipeline needs before any driver loads */
export interface AgentGuestLeaf<
  HarnessName extends string = string,
> extends Pick<
  AgentDriver,
  | 'guest'
  | 'install'
  | 'runtime'
  | 'guestPackages'
  | 'service'
  | 'releaseChannels'
> {
  /** how the agent names each harness it supports, keyed by exactly the supported harness driver ids */
  harnessNames: Readonly<Record<HarnessName, string>>;
}

/** the guest facts of a network the payload pipeline needs before any driver loads */
export interface NetworkGuestLeaf {
  /** compiled guest modules the network contributes to the deployable payload */
  guest: readonly GuestPayload[];
  /** release and version probe the guest installs while the network is selected */
  install: InstallSpec;
}

/** the guest facts of a component several drivers share */
export interface SharedGuestLeaf {
  /** compiled guest modules the component contributes to the deployable payload */
  guest: readonly GuestPayload[];
}
