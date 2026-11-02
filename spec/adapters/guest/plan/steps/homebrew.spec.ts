import { describe, expect, it } from 'vitest';

import { debianFamily } from '#adapters/guest/os/debian/family';
import { bottleProbe, homebrewStep } from '#adapters/guest/plan/steps/homebrew';

describe('fn:bottleProbe', () => {
  it('should omit the probe when no formula resolved', () => {
    expect(bottleProbe(debianFamily, [])).toBeUndefined();
  });
});

describe('fn:homebrewStep', () => {
  it('should omit package installation when no prerequisites are needed', () => {
    const step = homebrewStep({
      family: debianFamily,
      prerequisites: [],
      critical: false,
    });

    expect(step.apply.argv.join(' ')).not.toContain('oa_pkg_install');
    expect(step.apply.argv.join(' ')).toContain('oa_homebrew_install');
  });
});
