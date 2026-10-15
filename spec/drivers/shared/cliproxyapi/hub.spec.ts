import {
  mkdir,
  mkdtempDisposable,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { inspectHub, recordHub } from '#drivers/shared/cliproxyapi/hub';

import { createFilesystemSprite, guestOf } from '../../../mocks/sprites.js';

const RECORD = '/opt/open-agent/cliproxyapi.json';
const PROBE = '/opt/open-agent/drivers/shared/cliproxyapi/guest/hub-probe.js';

describe('fn:recordHub', () => {
  it('should record the model catalogue endpoint and client key for root only', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-hub-record-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });

    await recordHub(guestOf(sprite), {
      url: 'https://proxy.example/base',
      apiKey: 'client-key',
    });

    const record: unknown = JSON.parse(
      await readFile(join(directory.path, RECORD), 'utf8'),
    );
    const { mode } = await stat(join(directory.path, RECORD));
    expect(record).toEqual({
      models: 'https://proxy.example/base/v1/models',
      apiKey: 'client-key',
    });
    expect(mode & 0o777).toBe(0o600);
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
  it('should run the probe as root against the recorded gateway', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-hub-inspect-'),
    );
    await mkdir(join(directory.path, dirname(PROBE)), { recursive: true });
    await writeFile(join(directory.path, PROBE), 'probe installed');
    const execute = vi.fn(async () => ({
      stdout: JSON.stringify({
        reachable: false,
        reason: 'gateway record missing',
      }),
      stderr: '',
      exitCode: 0,
    }));
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    const status = await inspectHub(guestOf(sprite));

    expect(status).toEqual({
      reachable: false,
      skipped: false,
      status: undefined,
      reason: 'gateway record missing',
    });
    expect(execute).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      ['-n', '-E', '--', '/opt/open-agent/node/bin/node', PROBE, RECORD],
      expect.anything(),
    );
  });

  it('should report a probe that is not installed without running it', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-hub-inspect-'),
    );
    const execute = vi.fn();
    const sprite = createFilesystemSprite({ root: directory.path, execute });

    const status = await inspectHub(guestOf(sprite));

    expect(status).toEqual({
      reachable: false,
      skipped: false,
      reason: 'gateway probe is not installed',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
