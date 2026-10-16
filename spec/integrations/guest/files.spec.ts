import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeGuestFile } from '#integrations/guest/files';

import { createFilesystemSprite, guestOf } from '../../mocks/sprites';

describe('fn:writeGuestFile', () => {
  it('should reject home and noncanonical destinations before root SDK mutation', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-root-write-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });

    for (const path of [
      '/home',
      '/home/agent/settings.json',
      '/home/sprite/settings.json',
      '/opt/../home/agent/settings.json',
      'relative.json',
    ]) {
      await expect(
        writeGuestFile(guestOf(sprite), { path, contents: 'private' }),
      ).rejects.toThrow(/home files must be changed as their owning account/);
    }
    expect(sprite.execFile).not.toHaveBeenCalled();
    expect(sprite.execFileHTTP).not.toHaveBeenCalled();
  });
});
