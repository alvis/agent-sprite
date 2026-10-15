import { describe, expect, it } from 'vitest';

import { computeDeadline, isHolderLive } from '#guest/idle/deadline';

import type { HolderActivity } from '#guest/idle/deadline';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const SESSION_A = 'a'.repeat(64);
const SESSION_B = 'b'.repeat(64);
const OPTIONS = { now: NOW, idleTimeoutMinutes: 5, holdMaxMinutes: 60 };

/**
 * builds one holder's activity
 * @param overrides fields the case sets
 * @returns a claude holder that heartbeat now, with the overrides applied
 */
function holder(overrides: Partial<HolderActivity> = {}): HolderActivity {
  return {
    source: 'claude',
    session: SESSION_A,
    lastHeartbeat: NOW,
    ...overrides,
  };
}

describe('fn:computeDeadline', () => {
  it('should keep the workstation awake for the idle timeout after the latest heartbeat', () => {
    const result = computeDeadline({
      ...OPTIONS,
      holders: [
        holder({ lastHeartbeat: NOW - 3 * MINUTE }),
        holder({ session: SESSION_B, lastHeartbeat: NOW - MINUTE }),
      ],
    });

    expect(result).toEqual({
      lastHeartbeat: NOW - MINUTE,
      holds: [],
      deadline: NOW + 4 * MINUTE,
    });
  });

  it('should keep the workstation awake until the latest open hold expires', () => {
    const result = computeDeadline({
      ...OPTIONS,
      idleTimeoutMinutes: 0,
      holders: [
        holder({
          lastHeartbeat: NOW - MINUTE,
          holdExpiresAt: NOW + 10 * MINUTE,
        }),
        holder({
          session: SESSION_B,
          lastHeartbeat: NOW - MINUTE,
          holdExpiresAt: NOW + 30 * MINUTE,
        }),
      ],
    });

    expect(result.deadline).toBe(NOW + 30 * MINUTE);
    expect(result.holds.map(({ session }) => session)).toEqual([
      SESSION_B,
      SESSION_A,
    ]);
  });

  it('should take the later of the heartbeat deadline and the hold expiry', () => {
    const heartbeatLater = computeDeadline({
      ...OPTIONS,
      holders: [
        holder({ holdExpiresAt: NOW + 2 * MINUTE }),
        holder({ session: SESSION_B, lastHeartbeat: NOW }),
      ],
    });
    const holdLater = computeDeadline({
      ...OPTIONS,
      holders: [holder({ holdExpiresAt: NOW + 20 * MINUTE })],
    });

    expect(heartbeatLater.deadline).toBe(NOW + 5 * MINUTE);
    expect(holdLater.deadline).toBe(NOW + 20 * MINUTE);
  });

  it('should drop an expired hold, leaving only the heartbeat', () => {
    const result = computeDeadline({
      ...OPTIONS,
      holders: [
        holder({
          lastHeartbeat: NOW - 70 * MINUTE,
          holdExpiresAt: NOW - MINUTE,
        }),
      ],
    });

    expect(result).toEqual({
      lastHeartbeat: NOW - 70 * MINUTE,
      holds: [],
      deadline: NOW - 65 * MINUTE,
    });
  });

  it('should count only holds when the idle timeout is 0', () => {
    const heartbeatsOnly = computeDeadline({
      ...OPTIONS,
      idleTimeoutMinutes: 0,
      holders: [holder()],
    });

    expect(heartbeatsOnly).toEqual({ lastHeartbeat: NOW, holds: [] });
  });

  it('should clamp a heartbeat within the clock skew to now and a far hold to the hold maximum', () => {
    const result = computeDeadline({
      ...OPTIONS,
      holders: [
        holder({
          lastHeartbeat: NOW + MINUTE,
          holdExpiresAt: NOW + 6_000 * MINUTE,
        }),
      ],
    });

    expect(result).toEqual({
      lastHeartbeat: NOW,
      holds: [
        { source: 'claude', session: SESSION_A, expiresAt: NOW + 60 * MINUTE },
      ],
      deadline: NOW + 60 * MINUTE,
    });
  });

  it('should ignore a holder and a recorded heartbeat further in the future than the clock skew', () => {
    const result = computeDeadline({
      ...OPTIONS,
      holders: [
        holder({
          lastHeartbeat: NOW + MINUTE + 1,
          holdExpiresAt: NOW + 30 * MINUTE,
        }),
      ],
      recordedHeartbeat: NOW + 600 * MINUTE,
    });

    expect(result).toEqual({ holds: [] });
  });

  it('should keep a recorded heartbeat once its holder was pruned', () => {
    const result = computeDeadline({
      ...OPTIONS,
      holders: [],
      recordedHeartbeat: NOW - 2 * MINUTE,
    });

    expect(result.deadline).toBe(NOW + 3 * MINUTE);
  });

  it('should report no deadline when nothing keeps the workstation awake', () => {
    expect(computeDeadline({ ...OPTIONS, holders: [] })).toEqual({ holds: [] });
  });
});

describe('fn:isHolderLive', () => {
  it.each([
    ['a recent heartbeat', holder({ lastHeartbeat: NOW - MINUTE }), true],
    ['a spent heartbeat', holder({ lastHeartbeat: NOW - 6 * MINUTE }), false],
    [
      'an open hold behind a spent heartbeat',
      holder({ lastHeartbeat: NOW - 30 * MINUTE, holdExpiresAt: NOW + MINUTE }),
      true,
    ],
    [
      'an expired hold',
      holder({ lastHeartbeat: NOW - 70 * MINUTE, holdExpiresAt: NOW - MINUTE }),
      false,
    ],
    [
      'a heartbeat further ahead than the clock skew',
      holder({ lastHeartbeat: NOW + 2 * MINUTE, holdExpiresAt: NOW + MINUTE }),
      false,
    ],
  ])('should tell whether %s still counts', (_, activity, expected) => {
    expect(isHolderLive(activity, OPTIONS)).toBe(expected);
  });
});
