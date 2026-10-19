import { createInterface } from 'node:readline';

import { HOME } from '#adapters/guest/platform/account';

import type {
  GuestChannel,
  GuestProcess,
} from '#application/ports/guest-channel';

/** bounds of one conversation with a guest program */
interface LineProcessLimits {
  /** longest the whole conversation may take */
  timeoutMs: number;
  /** most output the program may print */
  outputChars: number;
}

/** how long a closing program may take before it is killed */
const SHUTDOWN_MS = 2_000;

/**
 * a native program run once as the agent on the guest, spoken to one JSON
 * line at a time: the host writes each request and parses each reply, so the
 * probe is one guest command whose output the host reads
 */
export class GuestLineProcess {
  readonly #process: GuestProcess;
  /** frames read but not yet taken */
  readonly #frames: unknown[] = [];
  /** the reader waiting for the next frame */
  #waiting:
    | { resolve: (frame: unknown) => void; reject: (error: Error) => void }
    | undefined;
  #failure: Error | undefined;
  #exited = false;
  readonly #exit: Promise<void>;
  readonly #timer: NodeJS.Timeout;

  /**
   * starts the program as the agent in its home
   * @param guest target guest
   * @param argv the program's absolute path and its arguments
   * @param options its environment and bounds
   * @param options.environment variables beside the agent's home
   * @param options.limits the conversation's time and output bounds
   */
  constructor(
    guest: GuestChannel,
    argv: readonly [string, ...string[]],
    options: {
      environment: Readonly<Record<string, string>>;
      limits: LineProcessLimits;
    },
  ) {
    const { environment, limits } = options;
    this.#process = guest.spawn({
      program: '/usr/bin/env',
      arguments: [`--chdir=${HOME}`, ...argv],
      account: 'agent',
      environment: { HOME, ...environment },
    });
    this.#exit = new Promise((resolve) => {
      this.#process.on('exit', () => {
        this.#exited = true;
        this.#fail('The program closed before it answered');
        resolve();
      });
    });
    this.#process.on('error', () => this.#fail('The program failed to run'));
    this.#process.stdin.on('error', () =>
      this.#fail('The program stopped reading its input'),
    );
    this.#process.stderr.resume();
    let printed = 0;
    this.#process.stdout.on('data', (chunk: Buffer | string) => {
      printed += chunk.length;
      if (printed > limits.outputChars) {
        this.#fail('The program printed more than its limit');
      }
    });
    const lines = createInterface({
      input: this.#process.stdout,
      crlfDelay: Infinity,
    });
    lines.on('line', (line) => this.#receive(line));
    lines.on('error', () => this.#fail('The program output failed'));
    this.#timer = setTimeout(
      () => this.#fail('The program did not answer in time'),
      limits.timeoutMs,
    );
  }

  /**
   * writes one request as a JSON line
   * @param frame the request
   */
  public send(frame: unknown): void {
    if (!this.#failure) {
      this.#process.stdin.write(`${JSON.stringify(frame)}\n`);
    }
  }

  /**
   * takes the next frame the program printed
   * @returns the parsed frame
   * @throws {Error} when the program failed, closed or timed out first
   */
  public async next(): Promise<unknown> {
    if (this.#frames.length > 0) {
      return this.#frames.shift();
    }
    if (this.#failure) {
      throw this.#failure;
    }

    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
    });
  }

  /** closes the program's input and waits for it to exit, killing it when it lingers */
  public async close(): Promise<void> {
    clearTimeout(this.#timer);
    this.#process.stdin.end();
    if (this.#exited) {
      return;
    }
    const kill = setTimeout(() => this.#process.kill(), SHUTDOWN_MS);
    try {
      await this.#exit;
    } finally {
      clearTimeout(kill);
    }
  }

  /**
   * parses one output line and hands it to the waiting reader
   * @param line one line the program printed
   */
  #receive(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.#fail('The program printed malformed output');

      return;
    }
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = undefined;
      waiting.resolve(frame);
    } else {
      this.#frames.push(frame);
    }
  }

  /**
   * keeps the first failure, rejects the waiting reader and stops the program
   * @param message fixed non-secret failure description
   */
  #fail(message: string): void {
    if (this.#failure) {
      return;
    }
    this.#failure = new Error(message);
    this.#waiting?.reject(this.#failure);
    this.#waiting = undefined;
    if (!this.#exited) {
      this.#process.kill();
    }
  }
}

/**
 * runs a conversation with a guest program and always closes it
 * @param program the started program
 * @param exchange the requests and replies
 * @returns what the exchange returns
 */
export async function converse<T>(
  program: GuestLineProcess,
  exchange: (program: GuestLineProcess) => Promise<T>,
): Promise<T> {
  try {
    return await exchange(program);
  } finally {
    await program.close();
  }
}
