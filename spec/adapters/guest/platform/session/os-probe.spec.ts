import { describe, expect, it } from 'vitest';

import { debianFamily } from '#adapters/guest/os/debian/family';
import { parseOsProbe } from '#adapters/guest/platform/session/os-probe';
import { registry } from '#composition/registry';

const images = registry.providers.sprite.images;
const release = 'release:ID=debian\nrelease:VERSION_ID=12';

describe('fn:parseOsProbe', () => {
  it('should refuse a family for which the provider declares no image', () => {
    expect(() => parseOsProbe(release, debianFamily, [])).toThrow(
      /no debian image/u,
    );
  });

  it.each([
    { reason: 'unnamed OS', report: '', message: /an unnamed OS/u },
    {
      reason: 'missing ID',
      report: 'release:ID_LIKE=debian\nrelease:VERSION_ID=12',
      message: /ID or VERSION_ID/u,
    },
    {
      reason: 'missing version',
      report: 'release:ID=debian',
      message: /ID or VERSION_ID/u,
    },
    {
      reason: 'missing architecture',
      report: release,
      message: /architecture.*not supported/u,
    },
    {
      reason: 'unknown architecture',
      report: `${release}\narch:riscv64`,
      message: /architecture.*not supported/u,
    },
  ])(
    'should refuse an incomplete or unsupported report ($reason)',
    ({ report, message }) => {
      expect(() => parseOsProbe(report, debianFamily, images)).toThrow(message);
    },
  );

  it('should parse a musl ARM release and ignore non-assignment lines', () => {
    const report = [
      "release:ID='debian'",
      "release:VERSION_ID='12'",
      "release:VERSION_CODENAME='bookworm'",
      'release:# a comment',
      'arch:aarch64',
      'libc:musl',
    ].join('\n');

    expect(parseOsProbe(report, debianFamily, images)).toEqual({
      family: 'debian',
      id: 'debian',
      versionId: '12',
      codename: 'bookworm',
      arch: 'aarch64',
      libc: 'musl',
    });
  });
});
