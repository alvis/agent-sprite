import { CommandFault } from '#errors';
import { checkOperation, currentOperation, runOperation } from '#operation';

import { prepareGuestTransaction } from './bootstrap.js';
import { transactionDiagnostics } from './diagnostics.js';
import {
  transactionCommandResult,
  transactionReadResult,
  transactionExistsResult,
  transactionMutationResult,
  assertTransactionSettlement,
  unresolvedTransaction,
  isTransactionRecord,
  waitForTransaction,
} from './protocol.js';

import type { GuestChannel, GuestProcess } from '#drivers/guest-channel';

import type {
  GuestCommandResult,
  GuestFileParams,
  GuestRunOptions,
} from '../types.js';

import type { PendingRequest, TransactionRequest } from './protocol.js';

const privateFileMode = 0o600;
const commandTimeoutMs = 120_000;
const acquisitionTimeoutMs = 90_000;
const bootstrapTimeoutMs = 1_500_000;
const releaseTimeoutMs = 30_000;
const heartbeatMs = 10_000;
const maximumFrameChars = 16_777_216;

/** serial framed transport; exclusion belongs to the remote worker, never this object */
export class GuestTransaction {
  public installed = false;
  readonly #command: GuestProcess;
  readonly #payloads: string;
  readonly #diagnostics: ReturnType<typeof transactionDiagnostics>;
  readonly #ready = Promise.withResolvers<void>();
  readonly #released = Promise.withResolvers<void>();
  readonly #requests = new Map<number, PendingRequest>();
  readonly #signal = currentOperation()?.signal;
  readonly #onAbort = (): void => this.stop();
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #buffer = '';
  #nextId = 0;
  #stopping = false;
  #releaseAcknowledged = false;
  #payloadSent = false;
  #readyAcknowledged = false;
  #queue: Promise<unknown> = Promise.resolve();

  /**
   * attaches to the private stream before the SDK's asynchronous spawn connects
   * @param command spawned root shell holding the descriptor through bootstrap
   * @param payloads fixed non-secret payload frames staged under the lock
   */
  private constructor(command: GuestProcess, payloads: string) {
    this.#command = command;
    this.#payloads = payloads;
    this.#diagnostics = transactionDiagnostics(command);
    void Promise.allSettled([this.#ready.promise, this.#released.promise]);
    command.stdout.setEncoding('utf8');
    command.stdout.on('data', (chunk: string) => this.receive(chunk));
    command.on('error', (error: unknown) =>
      this.failed('Guest transaction transport failed', error),
    );
    command.on('exit', (code: number) => {
      if (!this.#releaseAcknowledged) {
        this.failed(`Guest transaction exited with code ${code}`);
      }
    });
    command.stdin.on('error', (error: unknown) =>
      this.failed('Guest transaction input transport failed', error),
    );
    this.#signal?.addEventListener('abort', this.#onAbort, { once: true });
    if (this.#signal?.aborted) {
      this.stop();
    }
  }

  /**
   * starts fixed shell bootstrap and awaits the worker's actual ready acknowledgement
   * @param guest exact guest
   * @param bootstrap allows the first installer while ownership is already held
   * @returns ready transaction owner
   */
  public static async open(
    guest: GuestChannel,
    bootstrap: boolean,
  ): Promise<GuestTransaction> {
    const { command, payloads } = await prepareGuestTransaction(
      guest,
      bootstrap,
    );
    const transaction = new GuestTransaction(command, payloads);
    try {
      await runOperation(async () =>
        transaction.wait(
          transaction.#ready.promise,
          bootstrap ? bootstrapTimeoutMs : acquisitionTimeoutMs,
        ),
      );
      transaction.#heartbeat = setInterval(() => {
        if (!transaction.#stopping) {
          transaction.send({ type: 'heartbeat' });
        }
      }, heartbeatMs);

      return transaction;
    } catch (error) {
      transaction.stop();
      await transaction.finish().catch(() => undefined);
      checkOperation();
      throw error;
    }
  }

  /** rejects new work from cancelled or already-released host callbacks */
  public check(): void {
    checkOperation();
    if (this.#stopping) {
      throw unresolvedTransaction();
    }
  }

  /**
   * routes a protected native command to the guest and validates its reply
   * @param argv executable and arguments
   * @param options private input, environment and local waiting bound
   * @returns actual acknowledged command output and status
   */
  public async run(
    argv: readonly string[],
    options: GuestRunOptions,
  ): Promise<GuestCommandResult> {
    return this.request(
      { type: 'run', argv, input: options.input, env: options.env },
      transactionCommandResult,
      options.timeoutMs,
    );
  }

  /**
   * reads inside the same guest owner as the following mutation
   * @param path absolute guest file
   * @returns file contents
   */
  public async read(path: string): Promise<string> {
    return this.request({ type: 'read', path }, transactionReadResult);
  }

  /**
   * checks existence through the lock owner without SDK filesystem IO
   * @param path absolute guest path
   * @returns whether the guest path exists
   */
  public async exists(path: string): Promise<boolean> {
    return this.request({ type: 'exists', path }, transactionExistsResult);
  }

  /**
   * atomically writes a root-owned file inside the guest transaction
   * @param params validated destination, contents and permissions
   */
  public async write(params: GuestFileParams): Promise<void> {
    await this.request(
      { type: 'write', ...params, mode: params.mode ?? privateFileMode },
      transactionMutationResult,
    );
  }

  /**
   * removes a root-controlled file after accepted earlier work has settled
   * @param path root-controlled path
   */
  public async remove(path: string): Promise<void> {
    await this.request({ type: 'remove', path }, transactionMutationResult);
  }

  /** stops admission and waits for the guest's explicit release, never SDK exit */
  public async finish(): Promise<void> {
    this.stop();
    try {
      await this.wait(this.#released.promise, releaseTimeoutMs);
    } catch (error) {
      checkOperation();
      throw error;
    } finally {
      this.#signal?.removeEventListener('abort', this.#onAbort);
      this.#command.kill();
    }
  }

  /**
   * queues requests serially and blocks late callbacks after cancellation
   * @param request private protected operation
   * @param parseResult validates the matching operation before its promise resolves
   * @param timeoutMs caller waiting bound; expiry never kills accepted work
   * @returns acknowledged operation result
   */
  private async request<T>(
    request: TransactionRequest,
    parseResult: (result: unknown) => T,
    timeoutMs = commandTimeoutMs,
  ): Promise<T> {
    const pending = this.#queue.then(async () => {
      this.check();
      const id = ++this.#nextId;
      const reply = Promise.withResolvers<T>();
      this.#requests.set(id, {
        accepted: false,
        reject: reply.reject,
        resolve: (result) => reply.resolve(parseResult(result)),
      });
      this.send({ ...request, id });

      return runOperation(async () => this.wait(reply.promise, timeoutMs));
    });
    this.#queue = pending.catch(() => undefined);

    return pending;
  }

  /**
   * sends one JSON frame over stdin rather than process arguments
   * @param request private request or control message
   */
  private send(request: object): void {
    this.#command.stdin.write(`${JSON.stringify(request)}\n`);
  }

  /** stops future guest admission while allowing accepted work to settle */
  private stop(): void {
    if (this.#stopping) {
      return;
    }
    this.#stopping = true;
    clearInterval(this.#heartbeat);
    this.#command.stdin.end();
  }

  /**
   * decodes explicit acknowledgements without trusting SDK session exit
   * @param chunk newly received stdout protocol bytes
   */
  private receive(chunk: string): void {
    this.#buffer += chunk;
    if (this.#buffer.length > maximumFrameChars) {
      this.failed();

      return;
    }
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line === 'locked') {
        if (this.#payloadSent) {
          this.failed();

          return;
        }
        if (!this.#stopping) {
          this.#payloadSent = true;
          this.#command.stdin.write(this.#payloads);
        }
        continue;
      }
      try {
        const event: unknown = JSON.parse(line);
        this.acknowledge(event);
      } catch {
        this.failed();
      }
    }
  }

  /**
   * settles only requests explicitly acknowledged by the guest process
   * @param event parsed guest acknowledgement
   */
  private acknowledge(event: unknown): void {
    if (!isTransactionRecord(event)) {
      this.failed();

      return;
    }
    if (event.type === 'ready' && typeof event.installed === 'boolean') {
      this.acknowledgeReady(event.installed);
    } else if (event.type === 'released') {
      this.acknowledgeRelease(event.cleanupFailed);
    } else if (event.type === 'settled' && typeof event.id === 'number') {
      this.settle(event.id, event);
    } else if (event.type === 'accepted' && typeof event.id === 'number') {
      const request = this.#requests.get(event.id);
      if (!request || request.accepted) {
        this.failed();
      } else {
        request.accepted = true;
      }
    } else {
      this.failed();
    }
  }

  /**
   * accepts readiness only after the fixed bootstrap payload handoff
   * @param installed whether the bootstrap installer ran under ownership
   */
  private acknowledgeReady(installed: boolean): void {
    if (!this.#payloadSent || this.#readyAcknowledged || this.#stopping) {
      this.failed();

      return;
    }
    this.#readyAcknowledged = true;
    this.#diagnostics.clear();
    this.installed = installed;
    this.#ready.resolve();
  }

  /**
   * reports whether guest-owned transient-file cleanup settled successfully
   * @param failed cleanup outcome in the release acknowledgement
   */
  private acknowledgeRelease(failed: unknown): void {
    if (
      !this.#stopping ||
      this.#releaseAcknowledged ||
      this.#requests.size > 0 ||
      (failed !== undefined && typeof failed !== 'boolean')
    ) {
      this.failed();

      return;
    }
    this.#releaseAcknowledged = true;
    if (failed === true) {
      this.#released.reject(
        new CommandFault({
          code: 'PROVIDER',
          message: 'Guest lock released, but transient-file cleanup failed.',
        }),
      );
    } else {
      this.#released.resolve();
    }
  }

  /**
   * resolves only work whose earlier acceptance was acknowledged
   * @param id original host request identity
   * @param event guest completion record
   */
  private settle(id: number, event: Record<string, unknown>): void {
    const request = this.#requests.get(id);
    if (!request?.accepted) {
      this.failed();

      return;
    }
    assertTransactionSettlement(event);
    if (typeof event.failure === 'string') {
      request.reject(
        new CommandFault({
          code: 'PROVIDER',
          message: 'Guest filesystem operation failed.',
        }),
      );
    } else {
      request.resolve(event.result);
    }
    this.#requests.delete(id);
  }

  /**
   * rejects unresolved host waits without declaring guest work settled
   * @param message fixed transport status or protocol failure without diagnostics
   * @param cause private underlying transport failure
   */
  private failed(message?: string, cause?: unknown): void {
    this.stop();
    const error = unresolvedTransaction(
      message ? this.#diagnostics.failure(message, cause) : undefined,
    );
    this.#ready.reject(error);
    this.#released.reject(error);
    for (const request of this.#requests.values()) {
      request.reject(error);
    }
    this.#requests.clear();
  }

  /**
   * bounds host waiting while retaining the remote worker's ownership
   * @param pending explicit guest acknowledgement
   * @param timeoutMs host waiting deadline
   * @returns acknowledged value
   */
  private async wait<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
    return waitForTransaction(pending, timeoutMs, () => this.stop());
  }
}
