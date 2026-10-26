import { describe, expect, it } from 'vitest';

import { recordFrom, recordOf } from '#kernel/records';

describe('fn:recordOf', () => {
  it('should hold one built entry per key', () => {
    expect(recordOf(['claude', 'codex'], (key) => key.length)).toEqual({
      claude: 6,
      codex: 5,
    });
  });
});

describe('fn:recordFrom', () => {
  it('should key and value each item by its own derivation', () => {
    expect(
      recordFrom({
        items: ['claude', 'codex'],
        keyOf: (id) => `${id}Plugins` as const,
        valueOf: (id) => id.toUpperCase(),
      }),
    ).toEqual({ claudePlugins: 'CLAUDE', codexPlugins: 'CODEX' });
  });
});
