import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';

import { runBoundedIO } from '#operation';

import type { GuestAsset } from '#os/contracts';

/**
 * locates a guest program in the package: the build copies every `.sh` under
 * `src` to the same path under `lib`, so one path resolves from this module in
 * both the source and the packed layout
 * @param asset the guest program
 * @returns URL of the `.sh` file
 * @throws {Error} when the path is not a plain relative path to a `.sh` file
 */
export function assetUrl(asset: Pick<GuestAsset, 'path'>): URL {
  const { path } = asset;
  if (
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path.split('/').some((segment) => segment === '' || segment === '..') ||
    !path.endsWith('.sh')
  ) {
    throw new Error(`Guest asset ${path} is not a plain relative .sh path`);
  }

  return new URL(`../${path}`, import.meta.url);
}

/**
 * reads a guest program so setup can send it to the guest
 * @param asset the guest program
 * @returns its contents
 */
export async function readAsset(
  asset: Pick<GuestAsset, 'path'>,
): Promise<string> {
  const url = assetUrl(asset);

  return runBoundedIO(async () => readFile(url, 'utf8'));
}
