import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * removes the private directories an earlier install run left in a shared
 * directory when a signal ended it before its own clean-up. Only real
 * directories the given account owns are removed, since any account may add
 * entries to a shared temporary directory; the caller holds the lock that
 * keeps a second run from creating such a directory meanwhile
 * @param directory the shared directory
 * @param names the names the runs give their directories
 * @param owner the user id of the account that ran them
 */
export async function removeLeftovers(
  directory: string,
  names: RegExp,
  owner: number,
): Promise<void> {
  const matching = (await readdir(directory)).filter((name) =>
    names.test(name),
  );
  await Promise.all(
    matching.map(async (name) => {
      const path = join(directory, name);
      const entry = await lstat(path).catch(() => undefined);
      if (entry?.isDirectory() && entry.uid === owner) {
        await rm(path, { recursive: true, force: true });
      }
    }),
  );
}
