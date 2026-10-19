import { mkdtempDisposable, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  readOwnershipRecord,
  removeOwnershipRecord,
  restoreOwnedFile,
} from '#adapters/drivers/harnesses/shared/proxy-ownership';

import { createFilesystemSprite, guestOf } from '../../../../mocks/sprites';

describe('fn:readOwnershipRecord', () => {
  it('should reject malformed schema, fields, and required value evidence from actual persisted files', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-ownership-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const path = '/home/agent/ownership.json';
    await sprite.filesystem().mkdir('/home/agent', { recursive: true });
    for (const record of [
      null,
      { schema: 2, fields: {} },
      { schema: 1, fields: null },
      { schema: 1, fields: {} },
      {
        schema: 1,
        fields: {
          value: { previousPresent: 'invalid', managedValue: 'managed' },
        },
      },
      { schema: 1, fields: { value: { previousPresent: false } } },
    ]) {
      await sprite.filesystem().writeJSON(path, record);

      await expect(
        readOwnershipRecord(guestOf(sprite), path, ['value']),
      ).rejects.toEqual(expect.objectContaining({ code: 'PREFLIGHT' }));
      expect(
        JSON.parse(await readFile(join(directory.path, path), 'utf8')),
      ).toEqual(record);
    }
    await sprite.filesystem().writeFile(path, '{private-body');
    await expect(
      readOwnershipRecord(guestOf(sprite), path, ['value']),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'PREFLIGHT',
        cause: expect.any(SyntaxError),
        causeVisibility: 'private',
        message: expect.not.stringContaining('private-body'),
      }),
    );
    expect(await readFile(join(directory.path, path), 'utf8')).toBe(
      '{private-body',
    );
  });

  it('should tolerate an absent ownership record during cleanup without removing neighboring files', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-ownership-cleanup-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();
    const path = '/home/agent/ownership.json';
    await filesystem.mkdir('/home/agent', { recursive: true });
    await filesystem.writeFile('/home/agent/user.json', 'retained');

    await removeOwnershipRecord(guestOf(sprite), path);

    expect(await filesystem.exists(path)).toBe(false);
    expect(await filesystem.readFile('/home/agent/user.json', 'utf8')).toBe(
      'retained',
    );
  });
});

describe('fn:restoreOwnedFile', () => {
  it('should restore prior private content and removes newly owned files through the native helper', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-owned-file-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();
    await filesystem.mkdir('/home/agent/.codex', { recursive: true });
    const previousPath = '/home/agent/.codex/previous-token';
    const newPath = '/home/agent/.codex/new-token';
    await filesystem.writeFile(previousPath, 'managed');
    await filesystem.writeFile(newPath, 'managed');

    await restoreOwnedFile(guestOf(sprite), previousPath, {
      previousPresent: true,
      previousValue: 'prior',
      managedValue: 'managed',
    });
    await restoreOwnedFile(guestOf(sprite), newPath, {
      previousPresent: false,
      managedValue: 'managed',
    });

    expect(await readFile(join(directory.path, previousPath), 'utf8')).toBe(
      'prior',
    );
    expect((await stat(join(directory.path, previousPath))).mode & 0o777).toBe(
      0o600,
    );
    expect(await filesystem.exists(newPath)).toBe(false);
    expect(vi.mocked(sprite.execFileHTTP).mock.calls).toHaveLength(1);
    expect(
      vi
        .mocked(sprite.execFile)
        .mock.calls.some(([, args]) => args?.includes('remove')),
    ).toBe(true);
  });
});
