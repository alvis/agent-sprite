import { ExecError } from '@fly/sprites';

import { checkOperation, currentOperation, runOperation } from '#operation';

import { callSprites, toProviderFailure } from './failures.js';
import { privilegedArguments, SUDO_PROGRAM } from './privilege.js';
import { SpriteGuestProcess } from './process.js';
import { SpriteServiceControl } from './services.js';

import type { ExecResult, Sprite } from '@fly/sprites';

import type {
  GuestChannel,
  GuestCommand,
  GuestExecResult,
  GuestProcess,
  GuestServiceControl,
} from '#drivers/guest-channel';

const DEFAULT_TIMEOUT_MS = 120_000;
const KIBIBYTE_BYTES = 1024;
const MAX_BUFFER_BYTES = KIBIBYTE_BYTES * KIBIBYTE_BYTES;
const NETWORK_POLICY_MESSAGE =
  'Sprite network policy is enforced; refusing to replace its DNS configuration. No network policy was changed.';

/** binds a guest channel to one Sprite */
interface SpriteGuestChannelParams {
  /** exact target Sprite */
  sprite: Sprite;
  /** managed services that may be stopped and restored around a replacement */
  restorableServices: readonly string[];
}

/** the Sprite exec, filesystem and service APIs behind the guest contract */
export class SpriteGuestChannel implements GuestChannel {
  public readonly services: GuestServiceControl;
  readonly #sprite: Sprite;

  /**
   * binds the channel to one Sprite
   * @param params exact target Sprite and the services it may restore
   */
  constructor(params: SpriteGuestChannelParams) {
    const { sprite, restorableServices } = params;
    this.#sprite = sprite;
    this.services = new SpriteServiceControl({ sprite, restorableServices });
  }

  /**
   * runs a privileged command, returning a non-zero exit as a result
   * @param command command to run
   * @returns captured outcome
   */
  public async exec(command: GuestCommand): Promise<GuestExecResult> {
    const execute =
      command.input === undefined
        ? this.#sprite.execFile.bind(this.#sprite)
        : this.#sprite.execFileHTTP.bind(this.#sprite);
    let result: ExecResult;
    try {
      result = await runOperation(async () =>
        execute(SUDO_PROGRAM, commandArguments(command), {
          env: command.environment && { ...command.environment },
          signal: currentOperation()?.signal,
          input: command.input,
          timeout: command.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER_BYTES,
        }),
      );
    } catch (error) {
      checkOperation();
      if (!(error instanceof ExecError)) {
        throw toProviderFailure(error);
      }
      result = error.result;
    }

    return {
      exitCode: result.exitCode,
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  }

  /**
   * starts a privileged streaming process without a terminal
   * @param command command to start
   * @returns the running process
   */
  public spawn(command: GuestCommand): GuestProcess {
    return new SpriteGuestProcess(
      this.#sprite.spawn(SUDO_PROGRAM, commandArguments(command), {
        tty: false,
        ...(command.environment ? { env: { ...command.environment } } : {}),
      }),
    );
  }

  /**
   * tells whether a guest path exists
   * @param path absolute guest path
   * @returns true when the path exists
   */
  public async exists(path: string): Promise<boolean> {
    return callSprites(async () => this.#sprite.filesystem().exists(path));
  }

  /**
   * reads a guest file as UTF-8 text
   * @param path absolute guest path
   * @returns file contents
   */
  public async read(path: string): Promise<string> {
    return callSprites(async () =>
      this.#sprite.filesystem().readFile(path, 'utf8'),
    );
  }

  /** rejects when a Sprite network policy is enforced; never changes it */
  public async assertUnrestrictedNetwork(): Promise<void> {
    const policy = await runOperation(async () =>
      callSprites(async () => this.#sprite.getNetworkPolicy()),
    );
    if (policy.rules.length > 0) {
      throw new Error(NETWORK_POLICY_MESSAGE);
    }
  }
}

/**
 * renders a neutral command as sudo arguments
 * @param command neutral guest command
 * @returns sudo arguments
 */
function commandArguments(command: GuestCommand): string[] {
  return privilegedArguments(
    command.account,
    command.program,
    command.arguments,
  );
}
