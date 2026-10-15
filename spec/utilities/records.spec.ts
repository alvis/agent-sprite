import { describe, expect, it } from 'vitest';

import { recordFrom, recordOf } from '#utilities/records';

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
      recordFrom(
        ['claude', 'codex'],
        (id) => `${id}Plugins` as const,
        (id) => id.toUpperCase(),
      ),
    ).toEqual({ claudePlugins: 'CLAUDE', codexPlugins: 'CODEX' });
  });
});
