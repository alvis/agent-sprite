import { join } from 'node:path';

import { resolveTrustedFile } from '../native-files.js';

/**
 * resolves a root-owned management tool from fixed system directories
 * @param name executable filename
 * @param directories ordered system search directories
 * @returns absolute trusted executable path
 */
export async function findTrustedExecutable(
  name: string,
  directories: readonly string[],
): Promise<string> {
  for (const directory of directories) {
    const candidate = join(directory, name);
    try {
      return await resolveTrustedFile(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  throw new Error(`${name} was not found in a trusted system directory`);
}
