// dependency-free so the host catalog and the guest reader share one shape
// without the guest importing a host module; every import of it is type-only

/** one npm-installed component the guest scripts install and probe */
export interface ComponentEntry {
  /** key recorded in the manifest's installed versions */
  component: string;
  /** npm package that provides the component */
  package: string;
  /** program and arguments whose output reports the installed version */
  probe: string[];
  /** npm dist-tag the component is installed and updated from; absent means npm's default */
  distTag?: string;
}

/** the selected ACP agent as the guest scripts see it */
export interface AgentComponent extends ComponentEntry {
  /** agent identifier */
  id: string;
  /** release channel the agent follows; absent when the agent declares none */
  release?: string;
  /** how the agent names each harness, keyed by harness identifier */
  harnessNames: Record<string, string>;
  /** port the agent's service listens on */
  httpPort: number;
}

/** the selected private network's tool, which the guest installs and updates */
export interface NetworkComponent {
  /** network identifier */
  id: string;
  /** key recorded in the manifest's installed versions */
  component: string;
  /** upstream release feed the guest installs the latest release from */
  feed: string;
  /** guest module, deployed beside the core scripts, whose `installRelease` installs a release from the feed */
  installer: string;
  /** program and arguments whose output reports the installed version */
  probe: string[];
}

/**
 * the selected provider's capability axes the idle governor reads; the value
 * sets mirror `ProviderCapabilities`, and the host assigns the declared axes
 * to these fields, so a drift between the two fails typecheck
 */
export interface ProviderComponent {
  /** provider identifier */
  id: string;
  /** who decides when the workstation sleeps */
  keepAwakeMode: 'native-deadline' | 'governed' | 'none';
  /** how a sleeping workstation is woken */
  wakeMode: 'url-traffic' | 'cli-restore' | 'always-on';
  /** a cli-restore provider opts in to governor-initiated sleep */
  supportsCliWakeSleep: boolean;
  /** furthest ahead, in minutes, one deadline can keep the workstation awake; null when unlimited */
  maxAwakeDeadlineMinutes: number | null;
  /** whether the provider runs the services itself or a backend setup installs does, timer included */
  serviceBackend: 'provider' | 'runit';
  /** guest networks, as CIDR prefixes, a network tunnel must never route; empty when the provider needs none */
  transportNetworks: string[];
  /** the provider's `-awake` guest module, named by its path under the guest root; absent while the provider has none */
  awakeAdapter?: string;
}

/** what a guest script needs to know about the provider, the agent and the networks */
export interface ComponentCatalog {
  /** provider login accounts that share the agent's GitHub CLI login */
  shellAccounts: string[];
  /** the selected provider; absent from the seed the guest holds before the host records a selection */
  provider?: ProviderComponent;
  /** the selected ACP agent */
  agent: AgentComponent;
  /** the runtime the agent needs */
  runtime: ComponentEntry;
  /** npm packages the agent's guest modules import */
  packages: string[];
  /** the selected network's tool; empty when the selected network installs nothing */
  networks: NetworkComponent[];
}
