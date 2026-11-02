import { describe, expect, it } from 'vitest';

import { libraryCommand } from '#adapters/guest/platform/library';

describe('fn:libraryCommand', () => {
  it('should reject a library command without a function call', () => {
    expect(() => libraryCommand('/bin/sh', [], [])).toThrow(/call/iu);
  });
});
