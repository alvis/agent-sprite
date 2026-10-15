import { CommandFault } from '#errors';
import { isOwnAwakeModule } from '#guest/idle/provider-facts';

import { GUEST_LEAVES } from './guest-leaves.js';
import { selectedChannel } from './release-channels.js';

import type {
  ComponentCatalog,
  ComponentEntry,
  NetworkComponent,
  ProviderComponent,
} from '#drivers/component-types';
import type {
  AcpAdapterSpec,
  AgentGuestLeaf,
  InstallSpec,
  NetworkGuestLeaf,
  ProviderGuestLeaf,
} from '#drivers/contracts';

import type { NetworkId } from './catalog.js';

// the account each keep-awake mode runs its adapter as; a provider never kept
// awake declares no adapter
const ADAPTER_ACCOUNTS: Readonly<
  Record<ProviderComponent['keepAwakeMode'], string | undefined>
> = { 'native-deadline': 'agent', 'governed': 'root', 'none': undefined };

/** name of the file under the guest root that lists the selected harnesses */
export const HARNESS_CATALOG_FILE = 'harnesses.json';

/** name of the file under the guest root that lists the selected agent and network */
export const COMPONENT_CATALOG_FILE = 'components.json';

/** what a guest script needs to know about one selected harness */
export interface HarnessCatalogEntry {
  /** harness identifier */
  id: string;
  /** key recorded in the manifest's installed versions */
  component: string;
  /** npm package that provides the harness */
  package: string;
  /** program and arguments whose output reports the installed version */
  probe: string[];
  /** environment the ACP agent passes when spawning the harness */
  environment: Record<string, string>;
  /** the ACP adapter the harness provides, which the guest installs with it */
  adapter?: ComponentEntry;
}

/** the provider, ACP agent and network whose guest facts the component catalog carries */
export interface ComponentSelection {
  /** selected provider identifier */
  provider: keyof typeof GUEST_LEAVES.providers;
  /** selected ACP agent identifier */
  agent: keyof typeof GUEST_LEAVES.agents;
  /** selected network identifier; one that installs nothing has no guest leaf */
  network: NetworkId;
  /** the options that decide how the agent is installed; the agent's default channel when absent */
  options?: {
    /** release channel the agent follows */
    agentRelease?: string;
  };
}

/**
 * describes the first registered agent and no network, seeding the guest before
 * the host records the selected provider, agent and network
 *
 * the seed manages no provider shell account: the host replaces it with the
 * selected provider's catalog in the tools stage, before any core step touches
 * a shell account's home, and a union of every provider's accounts would let
 * the guest manage homes of accounts its provider never created
 * @returns the catalog guest scripts read
 * @throws {CommandFault} when no agent is registered
 */
export function seedComponentCatalog(): ComponentCatalog {
  const [entry] = Object.entries(GUEST_LEAVES.agents);
  if (entry === undefined) {
    throw new CommandFault({
      code: 'UNEXPECTED',
      message: 'No agent is registered',
    });
  }

  return {
    shellAccounts: [],
    ...agentComponents(...entry, undefined),
    networks: [],
  };
}

/**
 * describes one harness for the guest scripts that install and launch it
 * @param harness harness identifier with its install spec and spawn environment
 * @param harness.id harness identifier
 * @param harness.install package and version probe
 * @param harness.spawnEnvironment environment the ACP agent passes to the harness
 * @param harness.acpAdapter the ACP adapter the harness provides, when it provides one
 * @returns the catalog entry guest scripts read
 * @throws {CommandFault} when the harness or its adapter is not installable from npm
 */
export function harnessCatalogEntry(harness: {
  id: string;
  install: InstallSpec;
  spawnEnvironment: Readonly<Record<string, string>>;
  acpAdapter?: AcpAdapterSpec;
}): HarnessCatalogEntry {
  const { id, install, spawnEnvironment, acpAdapter } = harness;
  if (install.source.kind !== 'npm') {
    throw new CommandFault({
      code: 'UNEXPECTED',
      message: `Harness ${id} is not installable from npm`,
    });
  }

  return {
    id,
    component: install.component,
    package: install.source.package,
    probe: [install.versionProbe.program, ...install.versionProbe.arguments],
    environment: { ...spawnEnvironment },
    ...(acpAdapter && { adapter: npmComponent(id, acpAdapter.install) }),
  };
}

/**
 * lists every registered harness for the guest scripts, before a selection exists
 * @returns catalog entries in registration order
 */
export function registeredHarnessCatalog(): HarnessCatalogEntry[] {
  return Object.entries(GUEST_LEAVES.harnesses).map(([id, leaf]) =>
    harnessCatalogEntry({ id, ...leaf }),
  );
}

/**
 * describes the selected provider's accounts, the selected agent and the
 * selected network's installer for the guest scripts; a network that installs
 * nothing contributes no entry, so the guest installs and updates no tool for it
 * @param selection selected provider, ACP agent and network
 * @returns the catalog guest scripts read
 * @throws {CommandFault} when a component is not installable the way the guest expects
 */
export function componentCatalog(
  selection: ComponentSelection,
): ComponentCatalog {
  const { provider, agent, network } = selection;
  const leaf = GUEST_LEAVES.providers[provider];
  const leaves: Readonly<Record<string, NetworkGuestLeaf>> =
    GUEST_LEAVES.networks;
  const networkLeaf = Object.hasOwn(leaves, network)
    ? leaves[network]
    : undefined;

  return {
    shellAccounts: [...leaf.shellAccounts],
    provider: providerComponent(provider, leaf),
    ...agentComponents(
      agent,
      GUEST_LEAVES.agents[agent],
      selection.options?.agentRelease,
    ),
    networks: networkLeaf ? [releaseComponent(network, networkLeaf)] : [],
  };
}

/**
 * describes the provider's capability axes and awake adapter for the idle governor
 * @param id provider identifier
 * @param leaf the provider's guest facts
 * @returns the entry the governor reads
 * @throws {CommandFault} when the awake adapter is not an `-awake` module of
 * the provider's own guest folder, or is not deployed for the account that
 * runs it: a `native-deadline` adapter only ever runs as the agent account,
 * and a `governed` one as root, under the root import-graph rule
 */
function providerComponent(
  id: string,
  leaf: ProviderGuestLeaf,
): ProviderComponent {
  const { capabilities, awakeAdapter } = leaf;
  // the governor imports the adapter, so it must be code the provider itself
  // deploys under the fixed suffix, never a launcher or another driver's module
  if (
    awakeAdapter &&
    (!isOwnAwakeModule(awakeAdapter.module, id) ||
      awakeAdapter.account !== ADAPTER_ACCOUNTS[capabilities.keepAwakeMode])
  ) {
    throw new CommandFault({
      code: 'UNEXPECTED',
      message: `Awake adapter ${awakeAdapter.module} of ${id} is not an -awake module the provider deploys for its keep-awake mode`,
    });
  }

  return {
    id,
    keepAwakeMode: capabilities.keepAwakeMode,
    wakeMode: capabilities.wakeMode,
    supportsCliWakeSleep: capabilities.supportsCliWakeSleep,
    maxAwakeDeadlineMinutes: capabilities.maxAwakeDeadlineMinutes,
    servicesMode: capabilities.servicesMode,
    transportNetworks: [...capabilities.transportNetworks],
    ...(awakeAdapter && { awakeAdapter: awakeAdapter.module }),
  };
}

/**
 * describes an ACP agent for the guest scripts
 * @param id agent identifier
 * @param leaf the agent's guest facts
 * @param release release channel the workstation recorded, absent for the agent's default
 * @returns the catalog without the provider's shell accounts and the networks
 * @throws {CommandFault} when a component is not installable the way the guest expects,
 * or the agent does not declare the recorded channel
 */
function agentComponents(
  id: string,
  leaf: AgentGuestLeaf,
  release: string | undefined,
): Omit<ComponentCatalog, 'shellAccounts' | 'networks'> {
  const { httpPort } = leaf.service;
  if (httpPort === undefined) {
    throw new CommandFault({
      code: 'UNEXPECTED',
      message: `Agent ${id} declares no service port`,
    });
  }

  const channel = selectedChannel(leaf.releaseChannels, release);
  if (leaf.releaseChannels && channel === undefined) {
    throw new CommandFault({
      code: 'UNEXPECTED',
      message: `Agent ${id} declares no release channel "${release ?? leaf.releaseChannels.defaultChannel}"`,
    });
  }

  return {
    agent: {
      id,
      ...npmComponent(id, leaf.install),
      ...(channel && { distTag: channel.distTag, release: channel.id }),
      harnessNames: { ...leaf.harnessNames },
      httpPort,
    },
    runtime: npmComponent(id, leaf.runtime),
    packages: [...leaf.guestPackages],
  };
}

/**
 * describes an npm-installed component
 * @param owner identifier of the driver that installs it
 * @param install package and version probe
 * @returns the entry guest scripts read
 * @throws {CommandFault} when the component is not installable from npm
 */
function npmComponent(owner: string, install: InstallSpec): ComponentEntry {
  if (install.source.kind !== 'npm') {
    throw new CommandFault({
      code: 'UNEXPECTED',
      message: `Component ${install.component} of ${owner} is not installable from npm`,
    });
  }

  return {
    component: install.component,
    package: install.source.package,
    probe: [install.versionProbe.program, ...install.versionProbe.arguments],
  };
}

/**
 * describes a component installed from an upstream release feed
 * @param id identifier of the network that installs it
 * @param leaf the network's install spec and the guest modules it deploys
 * @returns the entry guest scripts read
 * @throws {CommandFault} when the component is not installable from a release
 * feed, or its installer is not a root module the network itself deploys
 */
function releaseComponent(
  id: string,
  leaf: NetworkGuestLeaf,
): NetworkComponent {
  const { install, guest } = leaf;
  if (install.source.kind !== 'release') {
    throw new CommandFault({
      code: 'UNEXPECTED',
      message: `Component ${install.component} of ${id} is not installable from a release feed`,
    });
  }
  const { installer } = install.source;
  // root imports the installer, so it must be root code of the same network,
  // and an `-install` module: a launcher runs its service when imported
  if (
    !installer.startsWith(`drivers/networks/${id}/guest/`) ||
    !installer.endsWith('-install.js') ||
    !guest.some(
      ({ module, account }) => module === installer && account === 'root',
    )
  ) {
    throw new CommandFault({
      code: 'UNEXPECTED',
      message: `Installer ${installer} of ${id} is not a root module the network deploys`,
    });
  }

  return {
    id,
    component: install.component,
    feed: install.source.feed,
    installer,
    probe: [install.versionProbe.program, ...install.versionProbe.arguments],
  };
}
