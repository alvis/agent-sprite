import { execa } from 'execa';

import { ProviderFault } from '#drivers/failures';
import { SESSION_PATH } from '#integrations/guest/session/framing';
import { currentOperation, runOperation } from '#operation';
import { familyOf } from '#os/families';
import { RunitServiceControl } from '#os/services/runit/backend';

import { flyctlAgent } from './agent.js';
import { FLYCTL, flyctlEnvironment, prepareFlyctlDirectory } from './flyctl.js';
import { inBandCommand, splitInBandStatus, verifiedStatus } from './in-band.js';
import { FLY_MACHINE_IMAGES } from './machine-config.js';
import { FlyGuestProcess } from './process.js';

import type {
  GuestChannel,
  GuestCommand,
  GuestExecResult,
  GuestProcess,
  GuestServiceControl,
} from '#drivers/guest-channel';

import type { FlyApi } from './api.js';

/** binds a guest channel to one machine */
export interface FlyGuestChannelParams {
  /** management API client, for short input-free checks */
  api: FlyApi;
  /** app name */
  app: string;
  /** machine identity */
  machine: string;
  /** resolves the app's SSH-scoped token, which never leaves this computer */
  sshToken: () => Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** the REST exec endpoint buffers output and gives up after about a minute */
const REST_EXEC_LIMIT_MS = 50_000;
const CHECK_TIMEOUT_MS = 30_000;
const MILLISECONDS_PER_SECOND = 1_000;
const KIBIBYTE_BYTES = 1024;
const MAX_BUFFER_BYTES = KIBIBYTE_BYTES * KIBIBYTE_BYTES;
const MISSING_PATH_STATUS = 1;
const TRANSPORT_DIAGNOSTIC_LENGTH = 300;
/** prefix dropping root privileges to the agent account */
const AGENT_PREFIX = ['/usr/sbin/runuser', '-u', 'agent', '--'] as const;
const ENV_PROGRAM = '/usr/bin/env';

/**
 * `fly ssh console` for streaming and input, and the Machines REST exec
 * endpoint for short input-free checks, behind the guest contract
 */
export class FlyGuestChannel implements GuestChannel {
  /** the runit services, controlled as root through this channel, so status needs no setup session */
  public readonly services: GuestServiceControl;
  readonly #params: FlyGuestChannelParams;

  /**
   * binds the channel to one machine
   * @param params API client, app, machine and SSH token source
   */
  constructor(params: FlyGuestChannelParams) {
    this.#params = params;
    this.services = new RunitServiceControl(
      async ([program, ...args], timeoutMs) =>
        this.exec({
          program,
          arguments: args,
          environment: { PATH: SESSION_PATH },
          timeoutMs,
        }),
      // every image a machine is created from is of one family
      familyOf(FLY_MACHINE_IMAGES[0]).shell,
    );
  }

  /**
   * runs a command as root or the agent account, returning a non-zero exit
   * as a result; a short command without input uses the REST endpoint,
   * anything else an SSH session reporting its status in band
   * @param command command to run
   * @returns captured outcome
   */
  public async exec(command: GuestCommand): Promise<GuestExecResult> {
    const words = commandWords(command);
    const { timeoutMs } = command;
    if (
      command.input === undefined &&
      timeoutMs !== undefined &&
      timeoutMs <= REST_EXEC_LIMIT_MS
    ) {
      return this.#restExec(words, timeoutMs);
    }

    return this.#sshExec(words, command.input, timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  /**
   * starts a streaming SSH session without a terminal
   * @param command command to start
   * @returns the running process
   */
  public spawn(command: GuestCommand): GuestProcess {
    const { line, marker } = inBandCommand(commandWords(command));

    return new FlyGuestProcess({
      program: FLYCTL,
      arguments: this.#sshArguments(line),
      marker,
      token: async () => {
        await prepareFlyctlDirectory();

        return this.#params.sshToken();
      },
    });
  }

  /**
   * tells whether a guest path exists
   * @param path absolute guest path
   * @returns true when the path exists
   */
  public async exists(path: string): Promise<boolean> {
    const result = await this.#restExec(
      ['/usr/bin/test', '-e', path],
      CHECK_TIMEOUT_MS,
    );
    if (result.exitCode !== 0 && result.exitCode !== MISSING_PATH_STATUS) {
      throw guestFailure(`test -e ${path}`, result);
    }

    return result.exitCode === 0;
  }

  /**
   * reads a guest file as UTF-8 text
   * @param path absolute guest path
   * @returns file contents
   */
  public async read(path: string): Promise<string> {
    const result = await this.#restExec(
      ['/bin/cat', '--', path],
      CHECK_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      throw guestFailure(`cat ${path}`, result);
    }

    return result.stdout;
  }

  /** a Fly Machine enforces no egress policy, so nothing can conflict */
  public async assertUnrestrictedNetwork(): Promise<void> {
    // Fly applies no provider network policy to a machine's own DNS
  }

  /**
   * runs a short input-free command through the REST exec endpoint
   * @param words program followed by its arguments
   * @param timeoutMs upper bound
   * @returns captured outcome
   */
  async #restExec(
    words: readonly string[],
    timeoutMs: number,
  ): Promise<GuestExecResult> {
    const { api, app, machine } = this.#params;
    const response = await api.exec(
      { app, machine },
      words,
      Math.ceil(timeoutMs / MILLISECONDS_PER_SECOND),
    );
    if (response.exitCode === undefined) {
      throw new ProviderFault({
        code: 'failed',
        message: `Fly exec of ${words[0] ?? 'a command'} reported no exit status`,
      });
    }

    return {
      exitCode: response.exitCode,
      stdout: response.stdout,
      stderr: response.stderr,
    };
  }

  /**
   * runs a command over SSH and reads its exit status from the in-band line
   * @param words program followed by its arguments
   * @param input standard input, closed after it is written
   * @param timeoutMs upper bound
   * @returns captured outcome
   */
  async #sshExec(
    words: readonly string[],
    input: string | undefined,
    timeoutMs: number,
  ): Promise<GuestExecResult> {
    await prepareFlyctlDirectory();
    const token = await this.#params.sshToken();
    const { line, marker } = inBandCommand(words);
    const result = await flyctlAgent.hold(async () =>
      runOperation(async () =>
        execa(FLYCTL, this.#sshArguments(line), {
          env: flyctlEnvironment(token),
          extendEnv: false,
          input: input ?? '',
          timeout: timeoutMs,
          cancelSignal: currentOperation()?.signal,
          maxBuffer: MAX_BUFFER_BYTES,
          encoding: 'buffer',
          // the guest's output is returned byte for byte, status line included
          stripFinalNewline: false,
          reject: false,
        }),
      ),
    );
    const transport = Buffer.from(result.stderr);
    const { stderr, status } = splitInBandStatus(transport, marker);
    if (result.timedOut) {
      throw new ProviderFault({
        code: 'failed',
        message: `Guest command ${words[0] ?? ''} timed out after ${timeoutMs} ms`,
      });
    }

    return {
      exitCode: verifiedStatus(status, result.exitCode, transport.toString()),
      stdout: Buffer.from(result.stdout).toString(),
      stderr: stderr.toString(),
    };
  }

  /**
   * builds the flyctl arguments of one session on this machine
   * @param line in-band command line
   * @returns flyctl arguments
   */
  #sshArguments(line: string): string[] {
    const { app, machine } = this.#params;

    return [
      'ssh',
      'console',
      '--app',
      app,
      '--machine',
      machine,
      '--quiet',
      '--command',
      line,
    ];
  }
}

/**
 * renders a neutral command as the words the guest runs, behind runuser for
 * the agent account and env for extra variables; the SSH session and the REST
 * endpoint both run as root
 * @param command neutral guest command
 * @returns program followed by its arguments
 */
export function commandWords(command: GuestCommand): string[] {
  const environment = Object.entries(command.environment ?? {}).map(
    ([name, value]) => `${name}=${value}`,
  );

  return [
    ...(command.account === 'agent' ? AGENT_PREFIX : []),
    ...(environment.length > 0 ? [ENV_PROGRAM, ...environment] : []),
    command.program,
    ...command.arguments,
  ];
}

/**
 * describes a failed filesystem check with the guest's own diagnostic
 * @param action what was attempted
 * @param result captured outcome
 * @returns a failed provider fault quoting the guest diagnostic
 */
function guestFailure(action: string, result: GuestExecResult): ProviderFault {
  return new ProviderFault({
    code: 'failed',
    message: `${action} exited ${result.exitCode}: ${result.stderr.trim().slice(-TRANSPORT_DIAGNOSTIC_LENGTH)}`,
  });
}
