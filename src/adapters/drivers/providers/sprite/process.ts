import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { toProviderFailure } from './failures';

import type { Readable, Writable } from 'node:stream';

import type { SpriteCommand } from '@fly/sprites';

import type { GuestProcess } from '#application/ports/guest-channel';

/** events a guest process reports */
interface GuestProcessEvents {
  /** process exit with its status */
  exit: [code: number];
  /** transport failure, already provider-neutral */
  error: [error: unknown];
}

/** a Sprite exec session presented as a provider-neutral process */
export class SpriteGuestProcess
  extends EventEmitter<GuestProcessEvents>
  implements GuestProcess
{
  public readonly stdin: Writable;
  public readonly stdout: Readable;
  public readonly stderr: Readable;
  readonly #command: SpriteCommand;
  /** buffers what the caller writes until the session's WebSocket opens, which refuses earlier input */
  readonly #input = new PassThrough();

  /**
   * wraps one started exec session, re-emitting its exit and translating its
   * SDK transport failures into provider-neutral failures; input reaches the
   * session once it has spawned
   * @param command SDK exec session
   */
  constructor(command: SpriteCommand) {
    super();
    this.#command = command;
    this.stdin = this.#input;
    command.once('spawn', () => {
      this.#input.pipe(command.stdin);
    });
    this.stdout = command.stdout;
    this.stderr = command.stderr;
    command.on('exit', (code: number) => this.emit('exit', code));
    command.on('error', (error: unknown) =>
      this.emit('error', toProviderFailure(error)),
    );
  }

  /** closes the exec session and its transport */
  public kill(): void {
    this.#command.close();
  }
}
