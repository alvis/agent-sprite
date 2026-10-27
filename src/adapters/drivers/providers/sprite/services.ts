import {
  CommandFault,
  ensureError,
  retainRecoveryFailure,
} from '#kernel/faults';
import { recoverOperation, runBoundedIO } from '#kernel/operation';

import { callSprites } from './failures';
import { privilegedArguments, SUDO_PROGRAM } from './privilege';
import { readServiceRegistry } from './services/registry';
import {
  consumeServiceStream,
  drainServiceStartup,
  openServiceStream,
  waitForService,
} from './services/stream';

import type {
  ServiceLogStream,
  ServiceRequest,
  ServiceWithState,
  Sprite,
} from '@fly/sprites';

import type { GuestServiceControl } from '#application/ports/guest-channel';
import type { GuestServiceState, ServiceDefinition } from '#domain/services';

const REPLACEMENT_STARTUP_WINDOW = '5s';
const STOP_TIMEOUT = '15s';

/** binds service control to one Sprite */
interface SpriteServiceControlParams {
  /** exact target Sprite */
  sprite: Sprite;
  /**
   * managed services this control may stop and restore while replacing a
   * service they depend on; core supplies them
   */
  restorableServices: readonly string[];
}

/** native Sprite service supervision behind the provider-neutral contract */
export class SpriteServiceControl implements GuestServiceControl {
  readonly #sprite: Sprite;
  readonly #restorable: readonly string[];

  /**
   * binds service requests to one Sprite
   * @param params exact Sprite and the services it may restore
   */
  constructor(params: SpriteServiceControlParams) {
    this.#sprite = params.sprite;
    this.#restorable = params.restorableServices;
  }

  /**
   * reads one strictly validated registry snapshot
   * @returns current services
   */
  public async list(): Promise<GuestServiceState[]> {
    return readServiceRegistry(this.#sprite);
  }

  /**
   * registers a definition, replacing a different one, and waits for running
   * @param definition desired service
   */
  public async ensure(definition: ServiceDefinition): Promise<void> {
    const { name } = definition;
    const request = serviceRequest(definition);
    const services = await runBoundedIO(async () =>
      this.#request(async () => this.#sprite.listServices()),
    );
    const existing = services.find((service) => service.name === name);
    const replacing = existing && !sameServiceDefinition(existing, request);
    const dependents = replacing
      ? services.filter((service) => service.needs.includes(name))
      : [];
    // only a managed consumer core named may be detached and restored while
    // replacing a dependency
    if (dependents.some(({ name }) => !this.#restorable.includes(name))) {
      throw new CommandFault({
        code: 'CONFLICT',
        message: `Cannot replace ${name} while an unmanaged service depends on it`,
      });
    }
    let failure: Error | undefined;
    try {
      for (const dependent of dependents) {
        await this.#replaceable(dependent);
      }
      if (replacing) {
        await this.#replaceable(existing);
      }
      await this.#start(name, request);
    } catch (error) {
      failure = ensureError(error);
    }
    failure = await this.#restoreDependents(dependents, failure);
    if (failure) {
      throw failure;
    }
  }

  /**
   * stops a service, consuming every stop event it reports
   * @param name service identifier
   * @returns true when the service reported no stop failure
   */
  public async stop(name: string): Promise<boolean> {
    const stream = await this.#stream(async () =>
      this.#sprite.stopService(name, STOP_TIMEOUT),
    );
    let isStopped = true;
    await consumeServiceStream(stream, (event) => {
      if (event.type === 'error') {
        isStopped = false;
      }
    });

    return isStopped;
  }

  /**
   * unregisters a service
   * @param name service identifier
   */
  public async remove(name: string): Promise<void> {
    await runBoundedIO(async () =>
      this.#request(async () => this.#sprite.deleteService(name)),
    );
  }

  /**
   * starts one service request, mapping SDK failures to provider faults
   * @param request SDK service request
   * @returns request outcome
   */
  async #request<T>(request: () => Promise<T>): Promise<T> {
    return callSprites(request);
  }

  /**
   * opens one service event stream
   * @param request SDK request returning a service event stream
   * @returns stream owned by the current invocation
   */
  async #stream(
    request: () => Promise<ServiceLogStream>,
  ): Promise<ServiceLogStream> {
    return openServiceStream(async () => this.#request(request));
  }

  /**
   * registers and starts one service, then waits for running state
   * @param name service identifier
   * @param request complete SDK service definition
   */
  async #start(name: string, request: ServiceRequest): Promise<void> {
    await drainServiceStartup(
      name,
      await this.#stream(async () =>
        this.#sprite.createService(name, request, REPLACEMENT_STARTUP_WINDOW),
      ),
    );
    await waitForService(this.#sprite, name);
  }

  /**
   * stops and removes one existing definition before replacement
   * @param service current provider-owned definition
   */
  async #replaceable(service: ServiceWithState): Promise<void> {
    if (service.state?.status === 'running') {
      await drainServiceStartup(
        service.name,
        await this.#stream(async () =>
          this.#sprite.stopService(service.name, REPLACEMENT_STARTUP_WINDOW),
        ),
      );
    }
    await this.remove(service.name);
  }

  /**
   * attempts every dependent in an independently bounded recovery scope
   * @param dependents services present before replacement
   * @param primary original failure, if any
   * @returns first failure with all secondary restoration details
   */
  async #restoreDependents(
    dependents: ServiceWithState[],
    primary?: Error,
  ): Promise<Error | undefined> {
    let failure = primary;
    for (const dependent of dependents) {
      try {
        await recoverOperation(async () =>
          this.#start(dependent.name, dependent),
        );
      } catch (error) {
        failure = failure
          ? retainRecoveryFailure(
              failure,
              `${dependent.name} service restoration`,
              error,
            )
          : ensureError(error);
      }
    }

    return failure;
  }
}

/**
 * renders a neutral definition as the privileged SDK request
 * @param definition desired service
 * @returns SDK request running behind sudo, and runuser for the agent account
 */
function serviceRequest(definition: ServiceDefinition): ServiceRequest {
  return {
    cmd: SUDO_PROGRAM,
    args: privilegedArguments(
      definition.account,
      definition.command,
      definition.arguments,
    ),
    needs: [...definition.needs],
    ...(definition.httpPort === undefined
      ? {}
      : { httpPort: definition.httpPort }),
  };
}

/**
 * compares the requested definition with the current provider-owned service
 * @param existing current service definition
 * @param requested desired supervised service definition
 * @returns whether the provider already has the requested configuration
 */
function sameServiceDefinition(
  existing: ServiceWithState,
  requested: ServiceRequest,
): boolean {
  return (
    existing.cmd === requested.cmd &&
    JSON.stringify(existing.args) === JSON.stringify(requested.args) &&
    JSON.stringify(existing.needs) === JSON.stringify(requested.needs) &&
    existing.httpPort === requested.httpPort
  );
}
