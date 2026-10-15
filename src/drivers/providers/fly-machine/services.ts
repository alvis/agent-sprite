import { ProviderFault } from '#drivers/failures';
import { GUEST_NODE } from '#guest/guest-root';
import {
  SUPERVISOR_CONTROL,
  isControlResponse,
} from '#guest/supervisor/protocol';

import type { ProviderErrorCode } from '#drivers/contracts';
import type {
  GuestChannel,
  GuestServiceControl,
  GuestServiceState,
  ServiceDefinition,
} from '#drivers/guest-channel';
import type {
  ControlFailureCode,
  ControlResponse,
} from '#guest/supervisor/protocol';

/** a short request runs through the REST exec endpoint */
const LIST_TIMEOUT_MS = 30_000;
/** a stop waits out the service's grace and a kill */
const STOP_TIMEOUT_MS = 45_000;
/** an ensure carries its definition on standard input, so it runs over SSH, and may replace and restart dependents */
const ENSURE_TIMEOUT_MS = 150_000;
const DIAGNOSTIC_LENGTH = 300;
/** the neutral class of each refusal the supervisor answers with */
const FAILURE_CODES: Readonly<Record<ControlFailureCode, ProviderErrorCode>> = {
  'invalid': 'failed',
  'conflict': 'conflict',
  'not-found': 'not-found',
  'unavailable': 'failed',
  'failed': 'failed',
};

/**
 * the supervised service control of a Fly Machine: every request runs the
 * guest supervisor's control entry as root through the guest channel, so it
 * is guarded by the surrounding guest transaction like any other guest IO
 */
export class FlySupervisedServices implements GuestServiceControl {
  readonly #channel: GuestChannel;

  /**
   * binds service requests to one machine's channel
   * @param channel the machine's guest channel
   */
  constructor(channel: GuestChannel) {
    this.#channel = channel;
  }

  /**
   * reads every supervised service, the maintenance timer among them
   * @returns current services
   */
  public async list(): Promise<GuestServiceState[]> {
    const response = await this.#request(['list'], LIST_TIMEOUT_MS);

    return (response.services ?? []).map(
      ({ name, status, needs, startedAt }) => ({
        name,
        status,
        needs,
        ...(startedAt !== undefined && { startedAt }),
      }),
    );
  }

  /**
   * registers a definition, replacing a different one, and waits for it to
   * run; an unchanged definition that already runs is left running
   * @param definition desired service
   */
  public async ensure(definition: ServiceDefinition): Promise<void> {
    await this.#request(
      ['ensure'],
      ENSURE_TIMEOUT_MS,
      JSON.stringify({
        name: definition.name,
        command: definition.command,
        arguments: definition.arguments,
        account: definition.account,
        needs: definition.needs,
        ...(definition.httpPort !== undefined && {
          httpPort: definition.httpPort,
        }),
      }),
    );
  }

  /**
   * stops a service and keeps it stopped, across boots too, until it is
   * ensured again
   * @param name service identifier
   * @returns true when the service stopped
   */
  public async stop(name: string): Promise<boolean> {
    const response = await this.#request(['stop', name], STOP_TIMEOUT_MS);

    return response.stopped ?? false;
  }

  /**
   * stops and unregisters a service
   * @param name service identifier
   */
  public async remove(name: string): Promise<void> {
    await this.#request(['remove', name], STOP_TIMEOUT_MS);
  }

  /**
   * runs the control entry once and reads its answer
   * @param words the action and its service identifier
   * @param timeoutMs upper bound of the guest command
   * @param input the definition an ensure carries
   * @returns the supervisor's successful answer
   * @throws {ProviderFault} when the supervisor refuses or gives no answer
   */
  async #request(
    words: readonly string[],
    timeoutMs: number,
    input?: string,
  ): Promise<Extract<ControlResponse, { ok: true }>> {
    const result = await this.#channel.exec({
      program: GUEST_NODE,
      arguments: [SUPERVISOR_CONTROL, ...words],
      ...(input !== undefined && { input }),
      timeoutMs,
    });
    const response = decode(result.stdout);
    if (!response) {
      throw new ProviderFault({
        code: 'failed',
        message: `The guest supervisor's ${words[0] ?? 'control'} request exited ${result.exitCode} without an answer: ${result.stderr.trim().slice(-DIAGNOSTIC_LENGTH)}`,
      });
    }
    if (!response.ok) {
      throw new ProviderFault({
        code: FAILURE_CODES[response.code],
        message: response.error,
      });
    }

    return response;
  }
}

/**
 * decodes the control entry's answer line
 * @param stdout the entry's standard output
 * @returns the validated answer, or undefined when there is none
 */
function decode(stdout: string): ControlResponse | undefined {
  try {
    const decoded: unknown = JSON.parse(stdout.trim().split('\n', 1)[0] ?? '');

    return isControlResponse(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}
