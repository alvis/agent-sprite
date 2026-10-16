import { mkdtempDisposable, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { inspectHub, recordHub } from '#drivers/shared/cliproxyapi/hub';
import { rememberSecret } from '#utilities/redaction';

import {
  createFilesystemSprite,
  guestOf,
  sessionGuestOf,
} from '../../../mocks/sprites';

const RECORD = '/opt/open-agent/cliproxyapi.curl';

describe('fn:recordHub', () => {
  it('should record the model catalogue endpoint and client key for root only, as a secret input', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-hub-record-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    rememberSecret('hub-client-key');

    await recordHub(sessionGuestOf(sprite), {
      url: 'https://proxy.example/base',
      apiKey: 'hub-client-key',
    });

    const { mode } = await stat(join(directory.path, RECORD));
    expect(await readFile(join(directory.path, RECORD), 'utf8')).toBe(
      'url = "https://proxy.example/base/v1/models"\n' +
        'header = "Authorization: Bearer hub-client-key"\n',
    );
    expect(mode & 0o777).toBe(0o600);
  });

  it('should refuse to write the client key outside a setup session', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-hub-record-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    rememberSecret('hub-session-key');

    await expect(
      recordHub(guestOf(sprite), {
        url: 'https://proxy.example',
        apiKey: 'hub-session-key',
      }),
    ).rejects.toThrow(/needs a setup session/);
    expect(sprite.execFileHTTP).not.toHaveBeenCalled();
  });

  it('should forget the record when no gateway is routed', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-hub-record-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    await recordHub(guestOf(sprite), {
      url: 'https://proxy.example',
      apiKey: 'client-key',
    });

    await recordHub(guestOf(sprite), undefined);

    expect(await sprite.filesystem().exists(RECORD)).toBe(false);
  });
});

describe('fn:inspectHub', () => {
  it('should ask the recorded gateway as root and report its status', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-hub-inspect-'),
    );
    const execute = vi.fn(async () => ({
      stdout: '200',
      stderr: '',
      exitCode: 0,
    }));
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    const status = await inspectHub(guestOf(sprite));

    expect(status).toEqual({ reachable: true, skipped: false, status: 200 });
    expect(execute).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      [
        '-n',
        '-E',
        '--',
        '/bin/sh',
        '-c',
        expect.stringContaining('curl'),
        'oa-hub',
        RECORD,
      ],
      expect.anything(),
    );
  });

  it.each([
    [64, 'gateway record missing'],
    [7, 'gateway request failed'],
  ])(
    'should report a probe exiting with %i as unreachable',
    async (exitCode, reason) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-hub-inspect-'),
      );
      const execute = vi.fn(async () => ({ stdout: '', stderr: '', exitCode }));
      const sprite = createFilesystemSprite({ root: directory.path, execute });

      await expect(inspectHub(guestOf(sprite))).resolves.toEqual({
        reachable: false,
        skipped: false,
        reason,
      });
    },
  );

  it('should reject a status that is not a number', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-hub-inspect-'),
    );
    const execute = vi.fn(async () => ({
      stdout: 'not-a-status',
      stderr: '',
      exitCode: 0,
    }));
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    await expect(inspectHub(guestOf(sprite))).rejects.toThrow(/malformed/);
  });
});
