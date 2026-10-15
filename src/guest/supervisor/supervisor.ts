import { checkNeeds, clearRestart, newEntry, statusOf } from './entries.js';
import { SupervisorFault } from './fault.js';
import { endLeftovers, serviceLogPath } from './processes.js';
import { isSameService } from './protocol.js';
import { ServiceRunner } from './runner.js';
import { readDesiredServices, writeDesiredServices } from './store.js';

import type { ServiceEntry, SupervisorParams } from './entries.js';
import type { SupervisedService, SupervisedServiceState } from './protocol.js';

// guest kernel: imports only Node built-ins and other guest code, and names no
// provider. The supervisor keeps the registry of services: what each runs as
// and needs, and whether it should run, recorded on the persistent guest root
// so the next start restores it. Requests run one after another; the runner
// keeps the processes in step with the registry

/** how long a stopped service may take to end before it is killed */
const STOP_GRACE_MS = 15_000;

/** runs the registered services */
export class Supervisor {
  readonly #params: SupervisorParams;
  readonly #entries = new Map<string, ServiceEntry>();
  readonly #runner: ServiceRunner;
  #queue: Promise<unknown> = Promise.resolve();

  /**
   * binds the supervisor to its directories, accounts and log
   * @param params directories, accounts, log, clock and trust check
   */
  constructor(params: SupervisorParams) {
    this.#params = params;
    this.#runner = new ServiceRunner(params, this.#entries);
  }

  /**
   * ends the children a previous supervisor of this boot left running, then
   * starts every service recorded as running, each after the services it needs
   */
  public async start(): Promise<void> {
    await endLeftovers(this.#params);
    const { entries, refused } = await readDesiredServices(
      this.#params.stateDirectory,
    );
    for (const reason of refused) {
      this.#params.log.write({ supervisor: 'state', refused: reason });
    }
    for (const { definition, desired } of entries) {
      this.#entries.set(definition.name, newEntry(definition, desired));
    }
    this.#params.log.write({
      supervisor: 'started',
      services: entries.length,
    });
    this.#runner.reconcile();
  }

  /**
   * reads every registered service's state in registration order
   * @returns the services' states
   */
  public list(): SupervisedServiceState[] {
    return [...this.#entries.values()].map((entry) => ({
      name: entry.definition.name,
      status: statusOf(entry),
      needs: [...entry.definition.needs],
      ...(entry.running &&
        !entry.running.isStopping && {
          startedAt: new Date(entry.running.startedAt).toISOString(),
        }),
    }));
  }

  /**
   * names every service log, for the timer to trim
   * @returns absolute log paths
   */
  public logPaths(): string[] {
    return [...this.#entries.keys()].map((name) =>
      serviceLogPath(this.#params.stateDirectory, name),
    );
  }

  /**
   * registers a definition and runs it; an unchanged definition that runs is
   * left running, and a changed one replaces the old after the running
   * services that need it stop, which then start again
   * @param definition the desired service
   */
  public async ensure(definition: SupervisedService): Promise<void> {
    await this.#serial(async () => this.#ensure(definition));
  }

  /**
   * stops a service and keeps it stopped, across a restart too
   * @param name service identifier
   * @returns whether the service's process ended
   */
  public async stop(name: string): Promise<boolean> {
    return this.#serial(async () => {
      const entry = this.#registered(name);
      entry.desired = 'stopped';
      entry.failures = 0;
      clearRestart(entry);
      await this.#persist();
      this.#params.log.write({ service: name, event: 'stop' });

      return this.#runner.terminate(entry, STOP_GRACE_MS);
    });
  }

  /**
   * stops and unregisters a service no other service needs
   * @param name service identifier
   */
  public async remove(name: string): Promise<void> {
    await this.#serial(async () => {
      const entry = this.#registered(name);
      const dependents = [...this.#entries.values()]
        .filter((other) => other.definition.needs.includes(name))
        .map((other) => other.definition.name);
      if (dependents.length > 0) {
        throw new SupervisorFault(
          'conflict',
          `${name} is needed by ${dependents.join(', ')}`,
        );
      }
      entry.desired = 'stopped';
      clearRestart(entry);
      if (!(await this.#runner.terminate(entry, STOP_GRACE_MS))) {
        throw new SupervisorFault('failed', `${name} did not stop`);
      }
      this.#entries.delete(name);
      await this.#persist();
      this.#params.log.write({ service: name, event: 'removed' });
    });
  }

  /**
   * ends every service at once, for the supervisor's own exit; the desired
   * state is kept, so the next start restores it
   */
  public async shutdown(): Promise<void> {
    await this.#runner.shutdown();
    this.#params.log.write({ supervisor: 'stopped' });
  }

  /**
   * runs one request after every earlier one settles
   * @param work the request
   * @returns the request's outcome
   */
  async #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => undefined);

    return result;
  }

  /**
   * registers, keeps or replaces a definition and waits for it to run
   * @param definition the desired service
   */
  async #ensure(definition: SupervisedService): Promise<void> {
    const { name } = definition;
    checkNeeds(this.#entries, definition);
    const existing = this.#entries.get(name);
    if (!existing) {
      const entry = newEntry(definition, 'running');
      this.#entries.set(name, entry);
      await this.#persist();
      this.#params.log.write({ service: name, event: 'registered' });
      const since = this.#params.now();
      this.#runner.reconcile();
      await this.#runner.awaitStartup(entry, since);

      return;
    }
    if (isSameService(existing.definition, definition)) {
      existing.desired = 'running';
      await this.#persist();
      if (existing.running && !existing.running.isStopping) {
        return;
      }
      // an ensure starts a waiting service now rather than after its delay
      clearRestart(existing);
      const since = this.#params.now();
      this.#runner.reconcile();
      await this.#runner.awaitStartup(existing, since);

      return;
    }
    await this.#replace(existing, definition);
  }

  /**
   * replaces a running definition: the running services that need it stop,
   * the old process ends, the new definition starts, and the services that
   * need it start again whether or not the new one did
   * @param existing the registered service
   * @param definition its new definition
   */
  async #replace(
    existing: ServiceEntry,
    definition: SupervisedService,
  ): Promise<void> {
    const { name } = definition;
    const dependents = [...this.#entries.values()].filter(
      (entry) => entry.definition.needs.includes(name) && entry.running,
    );
    for (const entry of [...dependents, existing]) {
      entry.isHeld = true;
    }
    const failures: Error[] = [];
    try {
      for (const entry of [...dependents, existing]) {
        if (!(await this.#runner.terminate(entry, STOP_GRACE_MS))) {
          throw new SupervisorFault(
            'failed',
            `${entry.definition.name} did not stop`,
          );
        }
      }
      existing.definition = definition;
      existing.desired = 'running';
      existing.failures = 0;
      clearRestart(existing);
      await this.#persist();
      this.#params.log.write({ service: name, event: 'replaced' });
      existing.isHeld = false;
      const since = this.#params.now();
      this.#runner.reconcile();
      await this.#runner.awaitStartup(existing, since);
    } catch (error) {
      failures.push(error as Error);
    } finally {
      existing.isHeld = false;
    }
    for (const entry of dependents) {
      entry.isHeld = false;
    }
    // a later dependent can crash while an earlier one is still starting
    const restartedAt = this.#params.now();
    this.#runner.reconcile();
    for (const entry of dependents) {
      await this.#runner
        .awaitStartup(entry, restartedAt)
        .catch((error: unknown) => {
          failures.push(error as Error);
        });
    }
    const [failure] = failures;
    if (failure) {
      throw failure;
    }
  }

  /** records every registered service and whether it should run */
  async #persist(): Promise<void> {
    await writeDesiredServices(
      this.#params.stateDirectory,
      [...this.#entries.values()].map(({ definition, desired }) => ({
        definition,
        desired,
      })),
    );
  }

  /**
   * finds a registered service
   * @param name service identifier
   * @returns the service
   * @throws {SupervisorFault} when no such service is registered
   */
  #registered(name: string): ServiceEntry {
    const entry = this.#entries.get(name);
    if (!entry) {
      throw new SupervisorFault(
        'not-found',
        `No service named ${name} is registered`,
      );
    }

    return entry;
  }
}
