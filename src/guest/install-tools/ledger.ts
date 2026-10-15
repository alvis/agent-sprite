import type { ComponentOutcome } from '../component-outcome.js';

/** a release whose version is the one an installed component is compared with */
export interface ResolvedRelease {
  /** exact version of the latest stable release; a prerelease the source publishes as latest stays exact */
  version: string;
}

/** how to find out about, and update, one component */
export interface ComponentInstall<Release extends ResolvedRelease> {
  /** key recorded in the manifest's installed versions */
  component: string;
  /** reads the latest stable release from the source the installer uses */
  resolve: () => Promise<Release>;
  /** reads the version actually installed, or nothing when the component is absent or unreadable; compared exactly with the resolved version */
  installed: () => Promise<string | undefined>;
  /** installs the resolved release */
  install: (release: Release) => Promise<void>;
}

/** outcome of one guarded step, with the value a successful step produced */
interface Attempt<Value> {
  value: Value;
}

const UNRESOLVED = 'latest version could not be resolved';
const FAILED = 'install failed';
const UNVERIFIED = 'installed version does not match the release';

/**
 * keeps what an install run did to each component, installing only the
 * components whose installed version differs from the latest stable one
 */
export class ComponentLedger {
  readonly #outcomes = new Map<string, ComponentOutcome>();
  readonly #note: (line: string) => void;
  readonly #save: (outcomes: Record<string, ComponentOutcome>) => Promise<void>;

  /**
   * @param note records a line in the private install log
   * @param earlier outcomes an earlier step of the same run already recorded
   * @param save leaves the outcomes so far where a crash or timeout cannot lose them
   */
  constructor(
    note: (line: string) => void,
    earlier: Record<string, ComponentOutcome> = {},
    save: (
      outcomes: Record<string, ComponentOutcome>,
    ) => Promise<void> = async () => undefined,
  ) {
    this.#note = note;
    this.#save = save;
    for (const [component, outcome] of Object.entries(earlier)) {
      this.#outcomes.set(component, outcome);
    }
  }

  /**
   * installs a component unless its probed version already equals the latest
   * stable one, noting how long it took; a failure is recorded rather than
   * thrown so the other components still update
   * @param spec how to resolve, probe and install the component
   */
  public async ensure<Release extends ResolvedRelease>(
    spec: ComponentInstall<Release>,
  ): Promise<void> {
    const started = performance.now();
    try {
      await this.#ensure(spec);
    } finally {
      this.#note(
        `Component ${spec.component} took ${Math.round(performance.now() - started)} ms`,
      );
    }
  }

  /**
   * lists what the run did to each component
   * @returns outcomes keyed by component
   */
  public outcomes(): Record<string, ComponentOutcome> {
    return Object.fromEntries(this.#outcomes);
  }

  /**
   * resolves, probes and, when they differ, installs and verifies one component
   * @param spec how to resolve, probe and install the component
   */
  async #ensure<Release extends ResolvedRelease>(
    spec: ComponentInstall<Release>,
  ): Promise<void> {
    const { component } = spec;
    const resolved = await this.#attempt(component, UNRESOLVED, spec.resolve);
    if (!resolved) {
      return;
    }
    const { version } = resolved.value;
    const probed = await this.#attempt(component, FAILED, spec.installed);
    if (!probed) {
      return;
    }
    if (probed.value === version) {
      await this.#record(component, { status: 'skipped', version });
      this.#note(`Component ${component} is current at ${version}; skipped`);

      return;
    }
    this.#note(
      `Component ${component} is ${probed.value ?? 'absent'}; installing ${version}`,
    );
    const installed = await this.#attempt(component, FAILED, async () =>
      spec.install(resolved.value),
    );
    if (!installed) {
      return;
    }
    // an installer that finished is not proof of an install: read it back
    const verified = await this.#attempt(component, FAILED, spec.installed);
    if (verified?.value === version) {
      await this.#record(component, { status: 'installed', version });
    } else if (verified) {
      this.#note(
        `Component ${component} reports ${verified.value ?? 'nothing'} after installing ${version}`,
      );
      await this.#record(component, { status: 'failed', error: UNVERIFIED });
    }
  }

  /**
   * fails the run when any component failed, after every component was tried
   * @throws {Error} naming the failed components
   */
  public assertNoFailures(): void {
    const failed = [...this.#outcomes]
      .filter(([, { status }]) => status === 'failed')
      .map(([component]) => component);
    if (failed.length > 0) {
      throw new Error(`Components failed: ${failed.join(', ')}`);
    }
  }

  /**
   * runs one step, recording the component as failed when it throws
   * @param component the component the step belongs to
   * @param reason fixed safe reason recorded on failure
   * @param step the step to run
   * @returns the step's value, or nothing when it failed
   */
  async #attempt<Value>(
    component: string,
    reason: string,
    step: () => Promise<Value>,
  ): Promise<Attempt<Value> | undefined> {
    try {
      return { value: await step() };
    } catch (error) {
      this.#note(`Component ${component} failed: ${(error as Error).message}`);
      await this.#record(component, { status: 'failed', error: reason });

      return undefined;
    }
  }

  /**
   * keeps one component's outcome and leaves every outcome so far on disk
   * @param component the component the outcome belongs to
   * @param outcome what the run did to it
   */
  async #record(component: string, outcome: ComponentOutcome): Promise<void> {
    this.#outcomes.set(component, outcome);
    await this.#save(this.outcomes());
  }
}
