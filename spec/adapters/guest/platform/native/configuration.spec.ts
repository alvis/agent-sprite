import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLAUDE_PLUGIN_STATE } from '#adapters/drivers/harnesses/claude/paths';
import { readSelectedPlugins } from '#adapters/guest/platform/native/configuration';

import { createFilesystemSprite, guestOf } from '../../../../mocks/sprites';

describe('fn:readSelectedPlugins', () => {
  it('should reject malformed persisted identities instead of treating them as an empty selection', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-invalid-selection-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
    for (const source of [
      '{private-body',
      '{"id":"incorrect"}',
      '["valid@market",1]',
    ]) {
      await sprite.filesystem().writeFile(CLAUDE_PLUGIN_STATE, source);

      await expect(
        readSelectedPlugins(guestOf(sprite), CLAUDE_PLUGIN_STATE),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'PREFLIGHT',
          ...(source === '{private-body'
            ? {
                cause: expect.any(SyntaxError),
                causeVisibility: 'private',
                message: expect.not.stringContaining('private-body'),
              }
            : {}),
        }),
      );
      expect(
        await readFile(join(directory.path, CLAUDE_PLUGIN_STATE), 'utf8'),
      ).toBe(source);
    }
  });
});
