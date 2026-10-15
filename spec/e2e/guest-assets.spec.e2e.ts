import { glob, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execPath } from 'node:process';
import { pathToFileURL } from 'node:url';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

import { packageRoot } from '../fixtures/packed-guest.js';

/**
 * lists every guest program in the checkout
 * @returns paths relative to `src`
 */
async function sourceAssets(): Promise<string[]> {
  const paths: string[] = [];
  for await (const path of glob('src/**/*.sh')) {
    paths.push(relative('src', path));
  }

  return paths.sort();
}

describe('packed guest assets', () => {
  it('should ship every guest program at its mirrored lib path', async () => {
    const root = await packageRoot();
    const assets = await sourceAssets();

    expect(assets.length).toBeGreaterThan(0);
    for (const path of assets) {
      await expect(readFile(join(root, 'lib', path), 'utf8')).resolves.toBe(
        await readFile(join('src', path), 'utf8'),
      );
    }
  });

  it('should read every guest program through the packed asset module', async () => {
    const root = await packageRoot();
    const assets = await sourceAssets();
    const module = pathToFileURL(join(root, 'lib', 'guest', 'assets.js')).href;

    const { stdout } = await execa(execPath, [
      '--input-type=module',
      '--eval',
      `const { readAsset } = await import(${JSON.stringify(module)});
const paths = ${JSON.stringify(assets)};
const contents = await Promise.all(paths.map((path) => readAsset({ path })));
process.stdout.write(JSON.stringify(contents));`,
    ]);

    expect(JSON.parse(stdout)).toEqual(
      await Promise.all(
        assets.map(async (path) => readFile(join('src', path), 'utf8')),
      ),
    );
  });

  it('should refuse an asset path that leaves the package', async () => {
    const root = await packageRoot();
    const module = pathToFileURL(join(root, 'lib', 'guest', 'assets.js')).href;

    const result = await execa(
      execPath,
      [
        '--input-type=module',
        '--eval',
        `const { readAsset } = await import(${JSON.stringify(module)});
await readAsset({ path: '../package.json' });`,
      ],
      { reject: false },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('is not a plain relative .sh path');
  });
});
