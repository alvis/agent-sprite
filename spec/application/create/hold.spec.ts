import { afterEach, describe, expect, it, vi } from 'vitest';

import { AWAKE_COMMAND } from '#adapters/guest/platform/awake';
import { withCreateHold } from '#application/create/hold';

import type { GuestChannel } from '#application/ports/guest-channel';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/**
 * a guest that records the awake events it is sent
 * @param exitCodes exit status of each successive event, then 0
 * @returns the guest, the actions it received in order, and the sessions used
 */
function recordingGuest(exitCodes: readonly number[] = []): {
  guest: GuestChannel;
  actions: string[];
  sessions: Set<string | undefined>;
} {
  const actions: string[] = [];
  const sessions = new Set<string | undefined>();
  const guest = {
    exec: vi.fn<GuestChannel['exec']>(async ({ program, arguments: args }) => {
      if (program !== AWAKE_COMMAND) {
        throw new Error(`unexpected program ${program}`);
      }
      actions.push(args[0] ?? '');
      sessions.add(args[args.indexOf('--session') + 1]);

      return {
        exitCode: exitCodes[actions.length - 1] ?? 0,
        stdout: '',
        stderr: '',
      };
    }),
  } satisfies Partial<GuestChannel> as Partial<GuestChannel> as GuestChannel;

  return { guest, actions, sessions };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('fn:withCreateHold', () => {
  it('should hold the workstation awake for the whole work and release it after', async () => {
    vi.useFakeTimers();
    const { guest, actions, sessions } = recordingGuest();
    const seen: string[][] = [];

    const pending = withCreateHold(AWAKE_COMMAND, guest, async () => {
      await vi.advanceTimersByTimeAsync(12 * MINUTE);
      seen.push([...actions]);

      return 'done';
    });
    const result = await pending;

    expect({
      result,
      duringWork: seen[0],
      afterwards: actions.slice(-1),
      oneSession: sessions.size,
    }).toEqual({
      result: 'done',
      // opened first, then refreshed every five minutes while the work ran
      duringWork: ['hold-open', 'hold-open', 'hold-open'],
      afterwards: ['hold-close'],
      oneSession: 1,
    });
  });

  it('should repeat the open at a short interval until the governor takes it', async () => {
    vi.useFakeTimers();
    // the awake command does not exist yet on the first two attempts
    const { guest, actions } = recordingGuest([127, 127]);

    await withCreateHold(AWAKE_COMMAND, guest, async () => {
      await vi.advanceTimersByTimeAsync(40 * SECOND);
    });

    expect(actions).toEqual([
      'hold-open',
      'hold-open',
      'hold-open',
      'hold-close',
    ]);
  });

  it('should release the hold and pass the failure on when the work fails', async () => {
    const { guest, actions } = recordingGuest();

    const outcome = await withCreateHold(AWAKE_COMMAND, guest, async () => {
      throw new Error('setup failed');
    }).then(
      () => 'resolved',
      (error: Error) => error.message,
    );

    expect({ outcome, actions }).toEqual({
      outcome: 'setup failed',
      actions: ['hold-open', 'hold-close'],
    });
  });

  it('should never fail the work because the hold could not be reached', async () => {
    const guest = {
      exec: vi.fn<GuestChannel['exec']>(async () => {
        throw new Error('guest unreachable');
      }),
    } satisfies Partial<GuestChannel> as Partial<GuestChannel> as GuestChannel;

    const result = await withCreateHold(
      AWAKE_COMMAND,
      guest,
      async () => 'done',
    );

    expect(result).toBe('done');
  });
});
