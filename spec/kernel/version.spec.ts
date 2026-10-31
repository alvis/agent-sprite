import { describe, expect, it } from 'vitest';

import { compareSemver } from '#kernel/version';

describe('fn:compareSemver', () => {
  it.each([
    {
      name: 'core before prerelease status',
      left: '2.0.0-alpha',
      right: '1.99.99',
      order: 1,
    },
    {
      name: 'release after prerelease',
      left: '1.0.0',
      right: '1.0.0-alpha',
      order: 1,
    },
    {
      name: 'numeric identifiers',
      left: '1.0.0-alpha.2',
      right: '1.0.0-alpha.10',
      order: -1,
    },
    {
      name: 'ascending text',
      left: '1.0.0-alpha',
      right: '1.0.0-beta',
      order: -1,
    },
    {
      name: 'descending text',
      left: '1.0.0-beta',
      right: '1.0.0-alpha',
      order: 1,
    },
    {
      name: 'equal prereleases',
      left: '1.0.0-alpha',
      right: '1.0.0-alpha',
      order: 0,
    },
    {
      name: 'numeric before text',
      left: '1.0.0-1',
      right: '1.0.0-alpha',
      order: -1,
    },
    {
      name: 'text after numeric',
      left: '1.0.0-alpha',
      right: '1.0.0-1',
      order: 1,
    },
    {
      name: 'longer prerelease',
      left: '1.0.0-alpha.1',
      right: '1.0.0-alpha',
      order: 1,
    },
    {
      name: 'shorter prerelease',
      left: '1.0.0-alpha',
      right: '1.0.0-alpha.1',
      order: -1,
    },
  ])(
    'should order $name by semantic version precedence',
    ({ left, right, order }) => {
      expect(Math.sign(compareSemver(left, right))).toBe(order);
    },
  );

  it('should reject an invalid version before comparing precedence', () => {
    expect(() => compareSemver('invalid', '1.0.0')).toThrow(
      'not a semantic version',
    );
  });
});
