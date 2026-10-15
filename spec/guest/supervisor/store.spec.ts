import { mkdtempDisposable, open, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readChildren,
  readDesiredServices,
  writeChildren,
  writeDesiredServices,
} from '#guest/supervisor/store';

import type { FileHandle } from 'node:fs/promises';

import type { DesiredService } from '#guest/supervisor/store';

/** the part of a file handle's prototype the test watches */
interface HandlePrototype {
  sync: (this: FileHandle) => Promise<void>;
}

const SERVICE: DesiredService = {
  definition: {
    name: 'alpha',
    command: '/bin/sleep',
    arguments: ['300'],
    account: 'agent',
    needs: [],
  },
  desired: 'running',
};

/**
 * records every sync of a file or directory, with the directory's listing at
 * that moment
 * @param directory the directory the records are written to
 * @returns the syncs in order
 */
async function watchSyncs(
  directory: string,
): Promise<Array<{ kind: string; listing: string[] }>> {
  const probe = await open(directory);
  const prototype = Object.getPrototypeOf(probe) as HandlePrototype;
  await probe.close();
  const original = prototype.sync;
  const syncs: Array<{ kind: string; listing: string[] }> = [];
  vi.spyOn(prototype, 'sync').mockImplementation(async function sync(
    this: FileHandle,
  ) {
    syncs.push({
      kind: (await this.stat()).isDirectory() ? 'directory' : 'file',
      listing: await readdir(directory),
    });

    return original.call(this);
  });

  return syncs;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fn:writeDesiredServices', () => {
  it('should sync the directory after the rename so the record survives a crash', async () => {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'oa-store-'));
    const syncs = await watchSyncs(scratch.path);

    await writeDesiredServices(scratch.path, [SERVICE]);

    expect(syncs).toEqual([
      { kind: 'file', listing: [expect.stringMatching(/^\.tmp-/u)] },
      { kind: 'directory', listing: ['services.json'] },
    ]);
    expect(await readDesiredServices(scratch.path)).toEqual({
      entries: [SERVICE],
      refused: [],
    });
  });
});

describe('fn:writeChildren', () => {
  it('should sync the directory after the rename of the children record too', async () => {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'oa-store-'));
    const syncs = await watchSyncs(scratch.path);

    await writeChildren(scratch.path, []);

    expect(syncs.map(({ kind, listing }) => ({ kind, listing }))).toEqual([
      { kind: 'file', listing: [expect.stringMatching(/^\.tmp-/u)] },
      { kind: 'directory', listing: ['children.json'] },
    ]);
    expect(await readChildren(scratch.path)).toEqual({
      entries: [],
      refused: [],
    });
  });
});
