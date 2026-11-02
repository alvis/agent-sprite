import { mkdtempDisposable, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { findTool } from '#adapters/host/tools';

describe('fn:findTool', () => {
  it('should return no executable when PATH is absent', async () => {
    vi.stubEnv('PATH', undefined);

    expect(await findTool('generated-tool')).toBeUndefined();
  });

  it('should select the first executable after missing and non-executable candidates', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-tool-path-'),
    );
    const blocked = join(directory.path, 'blocked');
    const first = join(directory.path, 'first');
    const second = join(directory.path, 'second');
    await Promise.all(
      [blocked, first, second].map(async (path) => mkdir(path)),
    );
    await writeFile(join(blocked, 'generated-tool'), '', { mode: 0o600 });
    await writeFile(join(first, 'generated-tool'), '', { mode: 0o700 });
    await writeFile(join(second, 'generated-tool'), '', { mode: 0o700 });
    vi.stubEnv(
      'PATH',
      [join(directory.path, 'missing'), '', blocked, first, second].join(
        delimiter,
      ),
    );

    expect(await findTool('generated-tool')).toBe(
      join(first, 'generated-tool'),
    );
  });
});
