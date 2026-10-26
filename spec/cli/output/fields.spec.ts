import { describe, expect, it } from 'vitest';

import { mapValues, projectFields, same } from '#cli/output/fields';

describe('fn:projectFields', () => {
  it('should preserve field order while omitting absent, unknown, and withheld fields', () => {
    const observed = {
      name: 'primary',
      privateNote: 'internal',
      missing: undefined,
      count: 3,
      unexpected: 'not part of the output contract',
    };
    const value: {
      name: string;
      privateNote: string;
      missing?: string;
      count: number;
    } = observed;

    const projected = projectFields<typeof value, object>(value, {
      count: (count) => count * 2,
      missing: same,
      privateNote: () => undefined,
      name: same,
    });

    expect(Object.entries(projected)).toEqual([
      ['name', 'primary'],
      ['count', 6],
    ]);
  });
});

describe('fn:mapValues', () => {
  it('should omit absent record values while preserving keys and transforming present values', () => {
    const observed = { second: 2, absent: undefined, first: 1 };

    const projected = mapValues((value: number) => value * 2)(observed);

    expect(Object.entries(projected)).toEqual([
      ['second', 4],
      ['first', 2],
    ]);
  });
});
