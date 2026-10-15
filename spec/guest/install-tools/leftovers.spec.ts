import { mkdir, mkdtempDisposable, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { removeLeftovers } from '#guest/install-tools/leftovers';

const OWNER = process.getuid?.() ?? 0;
const NAMES = /^(?:open-agent-install-|open-agent-homebrew-)[A-Za-z0-9]{6}$/u;

describe('fn:removeLeftovers', () => {
  it('should remove only the directories an earlier run of the account left', async () => {
    await using shared = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-leftovers-'),
    );
    await using elsewhere = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-leftovers-target-'),
    );
    await mkdir(join(shared.path, 'open-agent-install-a1B2c3', 'nested'), {
      recursive: true,
    });
    await mkdir(join(shared.path, 'open-agent-homebrew-z9Y8x7'));
    await mkdir(join(shared.path, 'open-agent-install-versions-a1B2c3'));
    await mkdir(join(shared.path, 'unrelated'));
    // a link someone planted under a run's name must not lead the sweep away
    await symlink(
      elsewhere.path,
      join(shared.path, 'open-agent-install-q1W2e3'),
    );

    await removeLeftovers(shared.path, NAMES, OWNER);

    expect((await readdir(shared.path)).sort()).toEqual([
      'open-agent-install-q1W2e3',
      'open-agent-install-versions-a1B2c3',
      'unrelated',
    ]);
    await expect(readdir(elsewhere.path)).resolves.toEqual([]);
  });

  it('should leave directories another account owns', async () => {
    await using shared = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-leftovers-'),
    );
    await mkdir(join(shared.path, 'open-agent-install-a1B2c3'));

    await removeLeftovers(shared.path, NAMES, OWNER + 1);

    expect(await readdir(shared.path)).toEqual(['open-agent-install-a1B2c3']);
  });
});
