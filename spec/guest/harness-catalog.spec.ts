import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { readHarnessCatalog } from '#guest/harness-catalog';

const { root } = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir: temporaryRoot } = await import('node:os');
  const { join: joinPath } = await import('node:path');

  return {
    root: await mkdtemp(joinPath(temporaryRoot(), 'open-agent-harnesses-')),
  };
});

vi.mock('#guest/guest-root', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#guest/guest-root')>()),
  GUEST_ROOT: root,
}));

const catalogPath = join(root, 'harnesses.json');
const HARNESS = {
  id: 'fixture',
  component: 'fixture',
  package: '@example/fixture',
  probe: ['fixture', '--version'],
  environment: { FIXTURE: '1' },
};
const ADAPTER = {
  component: 'fixture-acp',
  package: '@example/fixture-acp',
  probe: ['fixture-acp', '--version'],
};

/**
 * records a harness catalog the way the host does
 * @param catalog decoded catalog contents
 */
async function recordCatalog(catalog: unknown): Promise<void> {
  await writeFile(catalogPath, JSON.stringify(catalog));
}

afterEach(async () => {
  await rm(catalogPath, { force: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('fn:readHarnessCatalog', () => {
  it('should read a harness with the adapter it provides', async () => {
    await recordCatalog([{ ...HARNESS, adapter: ADAPTER }]);

    await expect(readHarnessCatalog()).resolves.toEqual([
      { ...HARNESS, adapter: ADAPTER },
    ]);
  });

  it('should read a harness that provides no adapter', async () => {
    await recordCatalog([HARNESS]);

    await expect(readHarnessCatalog()).resolves.toEqual([HARNESS]);
  });

  it.each([
    ['a package name that is not an npm name', { ...ADAPTER, package: '../x' }],
    ['no probe', { ...ADAPTER, probe: [] }],
    ['a value that is not an entry', 'fixture-acp'],
  ])('should refuse an adapter with %s', async (_label, adapter) => {
    await recordCatalog([{ ...HARNESS, adapter }]);

    await expect(readHarnessCatalog()).rejects.toThrow(
      'Managed harness catalog is malformed',
    );
  });

  it('should name the repair when the host has not written the catalog', async () => {
    await expect(readHarnessCatalog()).rejects.toThrow(
      `Managed harness catalog ${catalogPath} is missing`,
    );
  });
});
