import { describe, expect, it } from 'vitest';

import { harnessIds, harnessLabel, isHarnessId } from '#domain/harnesses';

describe('fn:harnessIds', () => {
  it('should list every registered harness in registration order', () => {
    expect(harnessIds()).toEqual(['claude', 'codex']);
  });
});

describe('fn:isHarnessId', () => {
  it('should accept registered identifiers only', () => {
    expect(isHarnessId('claude')).toBe(true);
    expect(isHarnessId('toString')).toBe(false);
    expect(isHarnessId('gemini')).toBe(false);
  });
});

describe('fn:harnessLabel', () => {
  it('should capitalize the identifier', () => {
    expect(harnessIds().map(harnessLabel)).toEqual(['Claude', 'Codex']);
  });
});
