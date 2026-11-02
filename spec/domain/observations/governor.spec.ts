import { describe, expect, it } from 'vitest';

import { isGovernorReport } from '#domain/observations/governor';

import type { GovernorState } from '#domain/observations/governor';

const INSTANT = '2026-10-25T00:00:00.000Z';
const HOLD = { source: 'claude', session: 'a'.repeat(64), expiresAt: INSTANT };
const STATE = {
  version: 1,
  updatedAt: INSTANT,
  idleTimeoutMinutes: 5,
  holdMaxMinutes: 60,
  holds: [],
  openHolds: 0,
  sleepPermitted: true,
  diagnostics: [],
} satisfies GovernorState;
const ADAPTER = { at: INSTANT, action: 'apply-deadline', result: 'applied' };

describe('fn:isGovernorReport', () => {
  it('should accept unavailable evidence with a readable reason', () => {
    expect(
      isGovernorReport({ recorded: false, reason: 'record not created' }),
    ).toBe(true);
  });
  it.each([
    {
      label: 'an active hold and successful deadline application',
      state: {
        ...STATE,
        keepAwakeMode: 'native-deadline',
        lastHeartbeat: INSTANT,
        holds: [HOLD],
        openHolds: 1,
        deadline: INSTANT,
        adapter: ADAPTER,
        diagnostics: ['held awake'],
      },
    },
    {
      label: 'a failed idle transition',
      state: {
        ...STATE,
        adapter: {
          at: INSTANT,
          action: 'enter-idle-form',
          failure: 'provider unavailable',
        },
      },
    },
  ])('should accept $label', ({ state }) => {
    expect(isGovernorReport({ recorded: true, state })).toBe(true);
  });

  it('should reject a nontext timestamp from an untrusted report', () => {
    expect(
      isGovernorReport({ recorded: true, state: { ...STATE, updatedAt: 1 } }),
    ).toBe(false);
  });
});
