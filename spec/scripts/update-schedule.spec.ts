import { describe, expect, it, vi } from 'vitest';

import { isUpdateDue } from '#scripts/update-schedule';

vi.useFakeTimers({
  toFake: ['Date'],
  now: new Date('2026-10-08T00:00:00.000Z'),
});

describe('fn:isUpdateDue', () => {
  it('should defer updates until seven days and treat missing valid history as due', () => {
    const lastSuccess = '2026-10-01T00:00:00.000Z';
    const boundary = Date.parse('2026-10-08T00:00:00.000Z');

    expect([
      isUpdateDue(lastSuccess, boundary - 1),
      isUpdateDue(lastSuccess, boundary),
      isUpdateDue(lastSuccess, boundary + 1),
      isUpdateDue('invalid', boundary),
      isUpdateDue(new Date().toISOString()),
    ]).toEqual([false, true, true, true, false]);
  });
});
