import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeWorkstationLabel } from '#adapters/guest/label';

import { createFilesystemSprite, guestOf } from '../../mocks/sprites';

describe('fn:writeWorkstationLabel', () => {
  it('should replace an existing label while preserving other machine information', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-label-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    await sprite
      .filesystem()
      .writeFile(
        '/etc/machine-info',
        ['ROLE=worker', 'PRETTY_HOSTNAME=old', '', ''].join('\n'),
      );

    await writeWorkstationLabel(guestOf(sprite), 'new');

    expect(
      await readFile(join(directory.path, '/etc/machine-info'), 'utf8'),
    ).toBe(['ROLE=worker', 'PRETTY_HOSTNAME=new', ''].join('\n'));
  });
});
