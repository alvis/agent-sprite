import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { SpriteGuestProcess } from '#adapters/drivers/providers/sprite/process';

import type { SpriteCommand } from '@fly/sprites';

/** an SDK exec session whose WebSocket opens when the test says */
interface FakeCommand {
  /** the session as the SDK hands it out */
  command: SpriteCommand;
  /** what reached the session's own input */
  received: () => string;
  /** opens the WebSocket, as the SDK's spawn event reports */
  open: () => void;
}

/**
 * builds an SDK exec session that refuses input until it has spawned, as the
 * SDK's WebSocket does
 * @returns the session and its controls
 */
function fakeCommand(): FakeCommand {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  let isOpen = false;
  let received = '';
  stdin.on('data', (chunk: Buffer) => {
    if (!isOpen) {
      events.emit('error', new Error('WebSocket not open'));

      return;
    }
    received += chunk.toString();
  });
  const command = Object.assign(events, {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    close: () => undefined,
  }) as unknown as SpriteCommand;

  return {
    command,
    received: () => received,
    open: () => {
      isOpen = true;
      events.emit('spawn');
    },
  };
}

describe('cl:SpriteGuestProcess', () => {
  it('should hold input written before the session spawned and deliver it once it has', async () => {
    const { command, received, open } = fakeCommand();
    const errors: unknown[] = [];
    const guest = new SpriteGuestProcess(command);
    guest.on('error', (error) => errors.push(error));

    guest.stdin.write('early\n');
    await new Promise((resolve) => setImmediate(resolve));
    open();
    guest.stdin.write('late\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect({ received: received(), errors }).toEqual({
      received: 'early\nlate\n',
      errors: [],
    });
  });
});
