import {
  chmod,
  mkdir,
  mkdtempDisposable,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isLockFile, withAwakeLock } from '#guest/idle/lock';

const SHORT_WAIT = { waitMs: 100, staleMs: 15_000 };
const WRITERS = 8;

/**
 * dates a file a minute back, as a lock a killed writer left behind
 * @param path absolute file path
 */
async function age(path: string): Promise<void> {
  const old = new Date(Date.now() - 60_000);
  await utimes(path, old, old);
}

describe('fn:withAwakeLock', () => {
  it('should keep a second writer out while the lock is held and release it after', async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'oa-lock-'));
    const lock = join(directory.path, '.lock');
    const inside = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const first = withAwakeLock(lock, async () => {
      inside.resolve(undefined);

      return release.promise;
    });
    await inside.promise;

    const second = await withAwakeLock(
      lock,
      async () => 'entered',
      SHORT_WAIT,
    ).catch((error: unknown) => error);
    release.resolve(undefined);
    await first;

    expect(second).toEqual(
      new Error('The awake lock is held by another writer'),
    );
    expect(await readdir(directory.path)).toEqual([]);
  });

  it('should break a lock a killed writer left behind', async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'oa-lock-'));
    const lock = join(directory.path, '.lock');
    await writeFile(lock, '4242 abandoned');
    await age(lock);

    const result = await withAwakeLock(lock, async () => 'entered', SHORT_WAIT);

    expect(result).toBe('entered');
    expect(await readdir(directory.path)).toEqual([]);
  });

  it('should release the lock when the action fails', async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'oa-lock-'));

    await expect(
      withAwakeLock(join(directory.path, '.lock'), async () => {
        throw new Error('write failed');
      }),
    ).rejects.toEqual(new Error('write failed'));
    expect(await readdir(directory.path)).toEqual([]);
  });

  it('should give up after the wait limit with the reason when a directory sits at the lock', async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'oa-lock-'));
    const lock = join(directory.path, '.lock');
    await mkdir(lock);
    await age(lock);
    const startedAt = Date.now();

    const failure = await withAwakeLock(
      lock,
      async () => 'entered',
      SHORT_WAIT,
    ).catch((error: unknown) => error);

    expect(failure).toEqual(new Error('The awake lock is not a regular file'));
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(SHORT_WAIT.waitMs);
  });

  it('should give up after the wait limit with the reason when a stale lock cannot be removed', async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'oa-lock-'));
    const lock = join(directory.path, '.lock');
    await writeFile(lock, '4242 abandoned');
    await age(lock);
    await chmod(directory.path, 0o555);

    const failure = await withAwakeLock(
      lock,
      async () => 'entered',
      SHORT_WAIT,
    ).catch((error: unknown) => error);
    await chmod(directory.path, 0o755);

    expect(failure).toEqual(new Error('The awake lock cannot be removed'));
    expect(await readdir(directory.path)).toEqual(['.lock']);
  });

  it('should let one writer at a time in when many break the same stale lock', async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'oa-lock-'));
    const lock = join(directory.path, '.lock');
    await writeFile(lock, '4242 abandoned');
    await age(lock);
    let inside = 0;
    let mostInside = 0;

    const entered = await Promise.all(
      Array.from({ length: WRITERS }, async (_, writer) =>
        withAwakeLock(
          lock,
          async () => {
            inside += 1;
            mostInside = Math.max(mostInside, inside);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inside -= 1;

            return writer;
          },
          { waitMs: 5_000, staleMs: 15_000 },
        ),
      ),
    );

    expect(entered.toSorted((left, right) => left - right)).toEqual(
      Array.from({ length: WRITERS }, (_, writer) => writer),
    );
    expect(mostInside).toBe(1);
    expect(await readdir(directory.path)).toEqual([]);
  });

  it('should leave a lock it no longer owns in place on release', async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'oa-lock-'));
    const lock = join(directory.path, '.lock');

    await withAwakeLock(lock, async () => {
      // another writer broke this lock and took its own
      await rm(lock);
      await writeFile(lock, '4343 other-writer');
    });

    expect(await readFile(lock, 'utf8')).toBe('4343 other-writer');
  });
});

describe('fn:isLockFile', () => {
  it.each([
    ['.lock', true],
    ['.apply.lock', true],
    ['.lock.break', true],
    ['.apply.lock.break', true],
    ['.lock.stale-1', false],
    ['lock', false],
    ['governor.json', false],
  ])('should tell whether %s is a lock file', (name, expected) => {
    expect(isLockFile(name)).toBe(expected);
  });
});
