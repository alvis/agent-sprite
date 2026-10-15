import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServiceLogStream } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { updateEntryCommand } from '#guest/update-schedule';
import {
  installManagedServices,
  installUpdateSchedule,
} from '#integrations/guest/services';

import { profileWith } from '../../fixtures/profile.js';
import { createFilesystemSprite, guestOf } from '../../mocks/sprites.js';

import type { Sprite } from '@fly/sprites';

import type { ProviderId } from '#core/catalog';

const helpPath = '/home/agent/.local/bin/t3';
const agentPath = 'PATH=/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin';
const helpArgv = [
  '-n',
  '-E',
  '--',
  '/usr/sbin/runuser',
  '-u',
  'agent',
  '--',
  '/usr/bin/env',
  '--chdir=/home/agent',
  agentPath,
  helpPath,
  'start',
  '--help',
];

describe('fn:installManagedServices T3 startup validation', () => {
  it('should check private startup flags as agent with managed Node before registering services', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-service-flags-'),
    );
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => ({
      stdout: args.includes('/usr/bin/id')
        ? '1002\n'
        : args.includes(helpPath)
          ? '--log-level --no-browser\n'
          : '',
      stderr: '',
      exitCode: 0,
    }));
    const sprite = Object.assign(
      createFilesystemSprite({ root: directory.path, execute }),
      {
        listServices: vi.fn<Sprite['listServices']>(async () => []),
        createService: vi.fn<Sprite['createService']>(
          async () =>
            new ServiceLogStream(
              new Response('{"type":"complete","timestamp":0}\n'),
            ),
        ),
        getService: vi.fn<Sprite['getService']>(async (name) => ({
          name,
          cmd: '/usr/bin/sudo',
          args: [],
          needs: [],
          state: { name, status: 'running' },
        })),
      },
    );
    await sprite.filesystem().mkdir('/opt/open-agent/t3-environment-probe', {
      recursive: true,
    });
    await sprite.filesystem().mkdir('/etc/cron.d', { recursive: true });
    await sprite.filesystem().writeJSON('/opt/open-agent/manifest.json', {
      schema: 1,
      createdAt: '2026-10-09T00:00:00Z',
      installedVersions: {},
      profile: profileWith({
        network: false,
        exitNode: false,
        cliproxyapi: false,
      }),
    });

    await installManagedServices(guestOf(sprite));

    expect(
      execute.mock.calls.filter(([, args]) => args?.includes(helpPath)),
    ).toEqual([['/usr/bin/sudo', helpArgv, expect.any(Object)]]);
    expect(sprite.createService.mock.calls).toEqual([
      [
        't3-code',
        expect.objectContaining({
          cmd: '/usr/bin/sudo',
          args: [
            '-n',
            '-E',
            '--',
            '/usr/sbin/runuser',
            '-u',
            'agent',
            '--',
            '/opt/open-agent/node/bin/node',
            '/opt/open-agent/drivers/agents/t3/guest/t3-launcher.js',
          ],
          needs: [],
          httpPort: 3773,
        }),
        '5s',
      ],
      [
        'open-agent-cron',
        expect.objectContaining({
          cmd: '/usr/bin/sudo',
          args: ['-n', '-E', '--', '/usr/sbin/cron', '-f'],
          needs: [],
        }),
        '5s',
      ],
    ]);
  });

  it('should report a missing Node shebang dependency without registering a service', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-service-path-failure-'),
    );
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => ({
      stdout: args.includes('/usr/bin/id') ? '1002\n' : '',
      stderr: args.includes(helpPath)
        ? "env: 'node': No such file or directory"
        : '',
      exitCode: args.includes(helpPath) ? 127 : 0,
    }));
    const sprite = createFilesystemSprite({ root: directory.path, execute });
    const createService = vi
      .spyOn(sprite, 'createService')
      .mockRejectedValue(new Error('unexpected service registration'));
    await sprite.filesystem().mkdir('/opt/open-agent/t3-environment-probe', {
      recursive: true,
    });
    await sprite.filesystem().writeJSON('/opt/open-agent/manifest.json', {
      schema: 1,
      createdAt: '2026-10-09T00:00:00Z',
      installedVersions: {},
      profile: profileWith({
        network: false,
        exitNode: false,
        cliproxyapi: false,
      }),
    });

    await expect(installManagedServices(guestOf(sprite))).rejects.toEqual(
      expect.objectContaining({
        code: 'PROVIDER',
        message: expect.stringMatching(
          /status 127: env: 'node': No such file or directory/u,
        ),
      }),
    );

    expect(
      execute.mock.calls.filter(([, args]) => args?.includes(helpPath)),
    ).toEqual([['/usr/bin/sudo', helpArgv, expect.any(Object)]]);
    expect(createService).not.toHaveBeenCalled();
  });
});

/**
 * records a manifest whose profile selects a provider
 * @param sprite filesystem-backed Sprite
 * @param provider the selected provider
 */
async function writeManifest(
  sprite: Sprite,
  provider: ProviderId = 'sprite',
): Promise<void> {
  await sprite.filesystem().writeJSON('/opt/open-agent/manifest.json', {
    schema: 1,
    createdAt: '2026-10-09T00:00:00Z',
    installedVersions: {},
    profile: {
      ...profileWith({ network: false, exitNode: false, cliproxyapi: false }),
      provider,
    },
  });
}

describe('fn:installUpdateSchedule', () => {
  it('should write the hourly cron entry of the update and touch no service', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-update-schedule-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    await writeManifest(sprite);
    const listServices = vi.spyOn(sprite, 'listServices');
    const createService = vi.spyOn(sprite, 'createService');

    await installUpdateSchedule(guestOf(sprite));

    expect({
      cron: await sprite
        .filesystem()
        .readFile('/etc/cron.d/open-agent', 'utf8'),
      services: [
        listServices.mock.calls.length,
        createService.mock.calls.length,
      ],
    }).toEqual({
      cron: `0 * * * * root /bin/sh -c '${updateEntryCommand()}' >/dev/null 2>&1\n`,
      services: [0, 0],
    });
  });

  it('should write no cron entry for a provider whose services the guest supervisor runs', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-update-supervised-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    await writeManifest(sprite, 'fly-machine');

    await installUpdateSchedule(guestOf(sprite));

    expect(await sprite.filesystem().exists('/etc/cron.d/open-agent')).toBe(
      false,
    );
  });
});
