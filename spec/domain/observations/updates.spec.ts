import { describe, expect, it } from 'vitest';

import { parseUpdateStatus } from '#domain/observations/updates';

describe('fn:parseUpdateStatus', () => {
  it.each(['{', 'null'])(
    'should withhold an unreadable update record %s',
    (text) => {
      expect(parseUpdateStatus(text)).toBeUndefined();
    },
  );

  it('should retain run metadata when no tool list was recorded', () => {
    expect(parseUpdateStatus('{"startedAt":"running"}')).toEqual({
      startedAt: 'running',
      tools: [],
    });
  });

  it('should discard malformed tool outcomes while retaining a usable sibling', () => {
    expect(
      parseUpdateStatus(
        JSON.stringify({
          tools: [
            null,
            {
              name: 'git',
              manager: 'brew',
              outcome: 'installed',
              required: false,
            },
          ],
        }),
      ),
    ).toEqual({
      tools: [
        { name: 'git', manager: 'brew', outcome: 'installed', required: false },
      ],
    });
  });
});
