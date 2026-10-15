import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadAwakeAdapter } from '#guest/idle/adapter';

import {
  createIdleRoot,
  FIXTURE_ADAPTER,
  fixtureAccounts,
  fixtureProvider,
  writeFixtureAdapter,
} from '../../fixtures/idle-root';

const T0 = Date.parse('2026-10-13T12:00:00.000Z');

describe('fn:loadAwakeAdapter', () => {
  it('should load the adapter its keep-awake mode calls', async () => {
    await using idle = await createIdleRoot(T0);
    await writeFixtureAdapter(idle.root);

    const loaded = await loadAwakeAdapter({
      ...idle.context,
      provider: fixtureProvider({ keepAwakeMode: 'governed' }),
    });

    expect(loaded).toEqual({
      mode: 'governed',
      adapter: expect.objectContaining({ enterIdleForm: expect.any(Function) }),
    });
  });

  it.each([
    [
      'a provider never kept awake',
      fixtureProvider({ keepAwakeMode: 'none' }),
      expect.stringContaining('no awake adapter'),
    ],
    [
      'an adapter in another provider folder',
      fixtureProvider({ id: 'other' }),
      expect.stringContaining("provider's own guest folder"),
    ],
    [
      'an adapter without the -awake suffix',
      fixtureProvider({
        awakeAdapter: 'drivers/providers/fixture/guest/fixture.js',
      }),
      expect.stringContaining("provider's own guest folder"),
    ],
    [
      'an adapter nested below the guest folder',
      fixtureProvider({
        awakeAdapter: 'drivers/providers/fixture/guest/nested/fixture-awake.js',
      }),
      expect.stringContaining("provider's own guest folder"),
    ],
  ])(
    'should refuse %s before importing anything',
    async (_, provider, message) => {
      await using idle = await createIdleRoot(T0);
      const trusted: string[] = [];

      await expect(
        loadAwakeAdapter({
          ...idle.context,
          provider,
          trust: async (path) => {
            trusted.push(path);

            return path;
          },
        }),
      ).rejects.toEqual(expect.objectContaining({ message }));
      expect(trusted).toEqual([]);
    },
  );

  it('should refuse a module that does not export what its mode calls', async () => {
    await using idle = await createIdleRoot(T0);
    await writeFixtureAdapter(idle.root);
    await writeFile(
      join(idle.root, FIXTURE_ADAPTER),
      'export const nothing = 1;\n',
    );

    await expect(
      loadAwakeAdapter({ ...idle.context, provider: fixtureProvider() }),
    ).rejects.toEqual(
      new Error(
        `awake adapter ${FIXTURE_ADAPTER} does not export what a native-deadline provider calls`,
      ),
    );
  });

  it('should refuse a native-deadline adapter as root before the module is imported', async () => {
    await using idle = await createIdleRoot(T0);
    await writeFixtureAdapter(idle.root);
    vi.spyOn(process, 'getuid').mockReturnValue(0);

    await expect(
      loadAwakeAdapter({ ...idle.context, provider: fixtureProvider() }),
    ).rejects.toEqual(
      new Error('a native-deadline adapter never runs as root'),
    );
    // the fixture records an import before anything else it does
    expect(await fixtureAccounts(idle.root)).toEqual([]);
  });

  it('should load a governed adapter as root', async () => {
    await using idle = await createIdleRoot(T0);
    await writeFixtureAdapter(idle.root);
    vi.spyOn(process, 'getuid').mockReturnValue(0);

    const loaded = await loadAwakeAdapter({
      ...idle.context,
      provider: fixtureProvider({ keepAwakeMode: 'governed' }),
    });

    expect(loaded.mode).toBe('governed');
  });
});
