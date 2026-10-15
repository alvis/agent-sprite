import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  isComponentOutcomes,
  readComponentOutcomes,
  writeComponentOutcomes,
} from '#guest/component-outcome';

const { root } = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir: temporaryRoot } = await import('node:os');
  const { join: joinPath } = await import('node:path');

  return {
    root: await mkdtemp(joinPath(temporaryRoot(), 'open-agent-outcomes-')),
  };
});

vi.mock('#guest/guest-root', () => ({ GUEST_ROOT: root }));

const outcomesPath = join(root, 'install-outcomes.json');

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('fn:isComponentOutcomes', () => {
  it('should accept every status with its optional version and reason', () => {
    expect(
      isComponentOutcomes({
        node: { status: 'skipped', version: '24.1.0' },
        jj: { status: 'installed', version: '0.31.0' },
        gh: { status: 'failed', error: 'install failed' },
        git: { status: 'failed' },
      }),
    ).toBe(true);
  });

  it.each([
    ['a non-object', 'skipped'],
    ['an unknown status', { jj: { status: 'pending' } }],
    ['a missing status', { jj: { version: '1.0.0' } }],
    ['a non-string version', { jj: { status: 'skipped', version: 1 } }],
    ['a non-string error', { jj: { status: 'failed', error: 7 } }],
    ['a non-object entry', { jj: 'skipped' }],
  ])('should reject %s', (_label, value) => {
    expect(isComponentOutcomes(value)).toBe(false);
  });
});

describe('fn:writeComponentOutcomes and fn:readComponentOutcomes', () => {
  it('should hand the outcomes of one run to the next reader and leave no temporary file', async () => {
    const outcomes = {
      node: { status: 'installed', version: '24.2.0' },
      jj: { status: 'failed', error: 'install failed' },
    } as const;

    await writeComponentOutcomes(outcomes);

    await expect(readComponentOutcomes()).resolves.toEqual(outcomes);
    expect(await readdir(root)).toEqual(['install-outcomes.json']);
  });

  it('should report no outcomes when no run has left any', async () => {
    await rm(outcomesPath, { force: true });

    await expect(readComponentOutcomes()).resolves.toBeUndefined();
  });

  it('should refuse a file that is not a set of outcomes', async () => {
    await writeFile(outcomesPath, JSON.stringify({ jj: { status: 'maybe' } }));

    await expect(readComponentOutcomes()).rejects.toEqual(
      new Error('Component install outcomes are malformed'),
    );
  });

  it('should refuse a file that is not JSON', async () => {
    await writeFile(outcomesPath, '{ not json');

    await expect(readComponentOutcomes()).rejects.toThrow(SyntaxError);
  });

  it('should surface a read failure other than a missing file', async () => {
    await rm(outcomesPath, { force: true });
    await mkdir(outcomesPath);

    await expect(readComponentOutcomes()).rejects.toThrow(
      expect.objectContaining({ code: 'EISDIR' }),
    );
    await rm(outcomesPath, { recursive: true });
  });
});
