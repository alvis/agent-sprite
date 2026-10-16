import { glob, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execPath } from 'node:process';
import { pathToFileURL } from 'node:url';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

import { packageRoot } from '../fixtures/packed-guest.js';

/**
 * lists every guest program in the checkout
 * @returns paths relative to `guest`
 */
async function sourceAssets(): Promise<string[]> {
  const paths: string[] = [];
  for await (const path of glob('guest/**/*.sh')) {
    paths.push(relative('guest', path));
  }

  return paths.sort();
}

/**
 * locates the packed asset module
 * @param root packed package root
 * @returns file URL of the module
 */
function assetModule(root: string): string {
  return pathToFileURL(join(root, 'lib', 'integrations', 'guest', 'assets.js'))
    .href;
}

describe('packed guest assets', () => {
  it('should ship every guest program at its install path under guest', async () => {
    const root = await packageRoot();
    const assets = await sourceAssets();

    expect(assets.length).toBeGreaterThan(0);
    for (const path of assets) {
      await expect(readFile(join(root, 'guest', path), 'utf8')).resolves.toBe(
        await readFile(join('guest', path), 'utf8'),
      );
    }
  });

  it('should read every guest program through the packed asset module behind the layout header', async () => {
    const root = await packageRoot();
    const assets = await sourceAssets();

    const { stdout } = await execa(execPath, [
      '--input-type=module',
      '--eval',
      `const { readAsset } = await import(${JSON.stringify(assetModule(root))});
const paths = ${JSON.stringify(assets)};
const contents = await Promise.all(paths.map((path) => readAsset({ path })));
process.stdout.write(JSON.stringify(contents));`,
    ]);
    const contents = JSON.parse(stdout) as string[];

    expect(contents).toHaveLength(assets.length);
    for (const [index, path] of assets.entries()) {
      const source = await readFile(join('guest', path), 'utf8');
      const shebang = /^#!.*\n/.exec(source)?.[0] ?? '';

      expect(contents[index]!.startsWith(shebang)).toBe(true);
      expect(contents[index]).toContain("\nOA_GUEST_ROOT='/opt/open-agent'\n");
      expect(
        contents[index]!.endsWith(
          `# ---- guest/${path} ----\n${source.slice(shebang.length)}`,
        ),
      ).toBe(true);
    }
  });

  it('should refuse an asset path that leaves the package', async () => {
    const root = await packageRoot();

    const result = await execa(
      execPath,
      [
        '--input-type=module',
        '--eval',
        `const { readAsset } = await import(${JSON.stringify(assetModule(root))});
await readAsset({ path: '../package.json' });`,
      ],
      { reject: false },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('is not a plain relative .sh path');
  });
});
