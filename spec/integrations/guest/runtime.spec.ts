import {
  mkdtemp,
  mkdtempDisposable,
  mkdir,
  writeFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { updateEntryCommand } from '#guest/update-schedule';
import { inspectGuest, installGuestTools } from '#integrations/guest/runtime';
import { assessReadiness } from '#readiness';

import { profileWith } from '../../fixtures/profile.js';
import {
  createFilesystemSprite,
  guestOf,
  serveServiceRegistry,
} from '../../mocks/sprites.js';

import type { ExecResult, ServiceWithState, Sprite } from '@fly/sprites';

import type { ProgressUpdate } from '#command';

describe('fn:inspectGuest', () => {
  it('should report inspection stages while preserving disabled integrations and returned evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-agent-inspect-'));
    const updates: ProgressUpdate[] = [];
    const sprite = Object.assign(
      createFilesystemSprite({
        root,
        execute: vi.fn<Sprite['execFile']>(async () => ({
          stdout: '[]',
          stderr: '',
          exitCode: 0,
        })),
      }),
      {
        listServices: vi.fn<Sprite['listServices']>(async () => []),
      } satisfies Partial<Sprite>,
    );
    serveServiceRegistry(sprite);
    try {
      await mkdir(join(root, 'opt/open-agent'), { recursive: true });
      await writeFile(
        join(root, 'opt/open-agent/manifest.json'),
        JSON.stringify({
          schema: 1,
          createdAt: '2026-10-07T00:00:00Z',
          lastSuccessfulUpdate: '2026-10-07T00:00:00Z',
          lastUpdateStatus: 'succeeded',
          installedVersions: {},
          profile: profileWith({
            network: false,
            exitNode: false,
            cliproxyapi: false,
          }),
        }),
      );
      const inspection = await inspectGuest(guestOf(sprite), (update) => {
        updates.push(update);
      });

      expect(inspection).toMatchObject({
        manifest: { profile: { network: 'none' } },
        services: [],
        network: { skipped: true, online: false },
        hub: { skipped: true, reachable: false },
        // the report entry printed no governor report
        governor: {
          recorded: false,
          reason: 'the governor report is unavailable',
        },
      });
      expect(updates[0]).toMatchObject({ stage: 'inspection' });
      const completed = updates.filter((update) => update.completed === 1);
      expect(completed.map((update) => update.stage).sort()).toEqual([
        'governor',
        'inspection',
        'native',
        'network',
        'proxy',
        'services',
      ]);
      expect(
        completed.every((update) => /\b\d{1,5}\.\d s\b/.test(update.message)),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('fn:installGuestTools', () => {
  it('should run the full installer after Node-only bootstrap before version probes and manifest success', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-install-versions-'),
    );
    const installer = Promise.withResolvers<ExecResult>();
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) =>
      args.includes('/opt/open-agent/guest/install-tools.js')
        ? installer.promise
        : { stdout: 'test-version\n', stderr: '', exitCode: 0 },
    );
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute,
    });
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });

    const installation = installGuestTools(
      guestOf(sprite),
      profileWith({
        network: false,
        exitNode: false,
        cliproxyapi: false,
      }),
    );
    await vi.waitFor(() =>
      expect(
        execute.mock.calls.filter(([, args]) =>
          args?.includes('/opt/open-agent/guest/install-tools.js'),
        ),
      ).toHaveLength(1),
    );
    expect(sprite.spawn).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      expect.arrayContaining(['open-agent-transaction', '1']),
      { tty: false },
    );
    expect(
      await sprite.filesystem().exists('/opt/open-agent/manifest.json'),
    ).toBe(false);
    expect(
      execute.mock.calls.some(([, args]) =>
        args?.some((arg) => arg === '--version' || arg === 'version'),
      ),
    ).toBe(false);

    installer.resolve({ stdout: '', stderr: '', exitCode: 0 });
    await installation;

    const versionCalls = execute.mock.calls
      .map(([file, args]) => [file, args ?? []] as const)
      .filter(
        ([, args]) => args.includes('--version') || args.includes('version'),
      );
    // the selected network is none, so no network tool is probed
    expect(versionCalls).toHaveLength(17);
    expect(
      versionCalls.every(
        ([file, args]) =>
          file === '/usr/bin/sudo' &&
          JSON.stringify(args.slice(0, 7)) ===
            JSON.stringify([
              '-n',
              '-E',
              '--',
              '/usr/sbin/runuser',
              '-u',
              'agent',
              '--',
            ]),
      ),
    ).toBe(true);
    expect(versionCalls.map(([, args]) => args.at(-2))).toEqual([
      '/opt/open-agent/node/bin/node',
      '/usr/local/bin/git',
      '/usr/local/bin/jj',
      '/usr/local/bin/gh',
      '/usr/local/bin/node',
      '/usr/local/bin/pnpm',
      '/usr/local/bin/python3',
      '/usr/local/bin/uv',
      '/usr/local/bin/rustup',
      '/usr/local/bin/http',
      '/usr/local/bin/agent-browser',
      '/usr/local/bin/rustc',
      '/usr/local/bin/google-chrome',
      '/home/agent/.local/bin/claude',
      '/home/agent/.local/bin/codex',
      '/home/agent/.local/bin/t3',
      '/home/agent/.local/bin/bun',
    ]);
    expect(
      await sprite
        .filesystem()
        .readJSON<Record<string, unknown>>('/opt/open-agent/manifest.json'),
    ).toMatchObject({
      lastUpdateStatus: 'succeeded',
      installedVersions: {
        'guest-node': 'test-version',
        'node': 'test-version',
      },
    });
  });

  it('should record and return what the installer did to each component', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-install-outcomes-'),
    );
    const outcomes = {
      'guest-node': { status: 'installed', version: '24.2.0' },
      'jj': { status: 'skipped', version: '0.31.0' },
    };
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => {
      if (args.includes('/opt/open-agent/guest/install-tools.js')) {
        await writeFile(
          join(directory.path, 'opt/open-agent/install-outcomes.json'),
          JSON.stringify(outcomes),
        );
      }

      return { stdout: 'test-version\n', stderr: '', exitCode: 0 };
    });
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute,
    });
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });

    const recorded = await installGuestTools(
      guestOf(sprite),
      profileWith({
        network: false,
        exitNode: false,
        cliproxyapi: false,
      }),
    );

    expect(recorded).toEqual(outcomes);
    expect(
      await sprite
        .filesystem()
        .readJSON<Record<string, unknown>>('/opt/open-agent/manifest.json'),
    ).toMatchObject({ componentOutcomes: outcomes });
  });

  it.each([
    [
      'report Node as installed when the transaction had to install it',
      false,
      'installed',
    ],
    ['keep Node as skipped when it was already there', true, 'skipped'],
  ] as const)(
    'should %s on a first installation',
    async (_label, isNodePresent, status) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-install-node-'),
      );
      const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => {
        if (args.includes('/opt/open-agent/guest/install-tools.js')) {
          // the installer's own Node gate finds the Node the transaction put there current
          await writeFile(
            join(directory.path, 'opt/open-agent/install-outcomes.json'),
            JSON.stringify({
              'guest-node': { status: 'skipped', version: '24.2.0' },
              'jj': { status: 'skipped', version: '0.31.0' },
            }),
          );
        }

        return { stdout: 'test-version\n', stderr: '', exitCode: 0 };
      });
      const sprite = createFilesystemSprite({
        root: directory.path,
        execute,
      });
      await sprite.filesystem().mkdir('/opt/open-agent/node/bin', {
        recursive: true,
      });
      if (isNodePresent) {
        await sprite
          .filesystem()
          .writeFile('/opt/open-agent/node/bin/node', '');
      }

      const recorded = await installGuestTools(
        guestOf(sprite),
        profileWith({ network: false, exitNode: false, cliproxyapi: false }),
      );

      expect(recorded).toEqual({
        'guest-node': { status, version: '24.2.0' },
        'jj': { status: 'skipped', version: '0.31.0' },
      });
    },
  );

  it('should keep the initial manifest absent when the full installer fails after Node bootstrap', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-install-failure-'),
    );
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => ({
      stdout: '',
      stderr: '',
      exitCode: args.includes('/opt/open-agent/guest/install-tools.js')
        ? 17
        : 0,
    }));
    const sprite = createFilesystemSprite({ root: directory.path, execute });
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });

    await expect(
      installGuestTools(
        guestOf(sprite),
        profileWith({
          network: false,
          exitNode: false,
          cliproxyapi: false,
        }),
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'PROVIDER' }));

    expect(
      execute.mock.calls.filter(([, args]) =>
        args?.includes('/opt/open-agent/guest/install-tools.js'),
      ),
    ).toHaveLength(1);
    expect(
      execute.mock.calls.some(([, args]) =>
        args?.some((arg) => arg === '--version' || arg === 'version'),
      ),
    ).toBe(false);
    expect(
      await sprite.filesystem().exists('/opt/open-agent/manifest.json'),
    ).toBe(false);
  });
  it('should redeploy the gate and the cron entry and rewrite the interval file from the stored profile when it refreshes an installed kernel', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-install-schedule-'),
    );
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: async () => ({
        stdout: 'test-version\n',
        stderr: '',
        exitCode: 0,
      }),
    });
    const stored = profileWith({
      network: false,
      exitNode: false,
      cliproxyapi: false,
    });
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
    await sprite.filesystem().writeJSON('/opt/open-agent/manifest.json', {
      schema: 1,
      createdAt: '2026-10-09T00:00:00Z',
      installedVersions: {},
      profile: {
        ...stored,
        options: {
          ...stored.options,
          updateDueIntervalDays: 3,
        },
      },
    });

    // the profile a caller passes is only for a first installation
    await installGuestTools(guestOf(sprite), stored);

    expect(
      await sprite.filesystem().readFile('/etc/cron.d/open-agent', 'utf8'),
    ).toEqual(expect.stringContaining(updateEntryCommand()));
  });

  it('should leave the first installation without a schedule until the services are installed', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-install-first-'),
    );
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: async () => ({
        stdout: 'test-version\n',
        stderr: '',
        exitCode: 0,
      }),
    });
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });

    await installGuestTools(
      guestOf(sprite),
      profileWith({ network: false, exitNode: false, cliproxyapi: false }),
    );

    expect(await sprite.filesystem().exists('/etc/cron.d/open-agent')).toBe(
      false,
    );
  });
});

const runningService = {
  name: 't3-code',
  cmd: '/opt/open-agent/t3-launcher',
  args: [],
  needs: [],
  state: { name: 't3-code', status: 'running' },
} satisfies ServiceWithState;

describe('fn:inspectGuest independent probe failures', () => {
  it.each([
    {
      failed: 'services',
      proxy: false,
      reason: 'Service registry response could not be read.',
    },
    { failed: 'native', proxy: false, reason: 'native SDK probe unavailable' },
    { failed: 'proxy', proxy: true, reason: 'unavailable' },
  ] as const)(
    'should retain fulfilled siblings when $failed fails',
    async ({ failed, proxy, reason }) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-inspect-failure-'),
      );
      const execute = vi.fn<Sprite['execFile']>(
        async (_file, args = []): Promise<ExecResult> => {
          if (
            (failed === 'native' &&
              args.includes('plugin') &&
              args.includes('list')) ||
            (failed === 'proxy' &&
              args.includes(
                '/opt/open-agent/drivers/shared/cliproxyapi/guest/hub-probe.js',
              ))
          ) {
            throw new Error(`${failed} SDK probe unavailable`);
          }

          return {
            stdout: args.includes(
              '/opt/open-agent/drivers/shared/cliproxyapi/guest/hub-probe.js',
            )
              ? '{"reachable":true}'
              : '[]',
            stderr: '',
            exitCode: 0,
          };
        },
      );
      const sprite = Object.assign(
        createFilesystemSprite({ root: directory.path, execute }),
        {
          listServices: vi.fn<Sprite['listServices']>(async () => {
            if (failed === 'services') {
              throw new Error('service SDK list unavailable');
            }

            return [runningService];
          }),
        },
      );
      serveServiceRegistry(sprite);
      await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
      await sprite.filesystem().writeJSON('/opt/open-agent/manifest.json', {
        schema: 1,
        createdAt: '2026-10-09T00:00:00Z',
        installedVersions: {},
        profile: profileWith({
          network: false,
          exitNode: false,
          cliproxyapi: proxy,
        }),
      });
      if (proxy) {
        await sprite
          .filesystem()
          .writeFile(
            '/opt/open-agent/drivers/shared/cliproxyapi/guest/hub-probe.js',
            'probe installed',
          );
      }
      const progress: Array<{
        stage: string;
        message: string;
        completed?: number;
      }> = [];

      const inspection = await inspectGuest(guestOf(sprite), (update) =>
        progress.push(update),
      );
      const readiness = assessReadiness(inspection);

      expect(inspection.probeFailures).toEqual([
        { probe: failed, reason: expect.stringContaining(reason) },
      ]);
      expect(readiness).toMatchObject({
        ready: false,
        failures: expect.arrayContaining([`${failed} inspection unavailable`]),
        probeFailures: inspection.probeFailures,
      });
      expect(inspection.network).toMatchObject({ skipped: true });
      expect(progress).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: failed,
            message: expect.stringContaining('Check failed'),
          }),
          expect.objectContaining({ stage: 'network', completed: 1 }),
        ]),
      );
      if (failed === 'services') {
        expect(inspection.services).toEqual([]);
        expect(inspection.native).toBeDefined();
      } else {
        expect(inspection.services).toEqual([
          { name: 't3-code', needs: [], status: 'running' },
        ]);
      }
      if (failed === 'native') {
        expect(inspection.native).toBeUndefined();
        expect(inspection.hub).toMatchObject({ skipped: true });
      } else {
        expect(inspection.native).toBeDefined();
      }
      if (failed === 'proxy') {
        expect(inspection.hub).toMatchObject({
          reachable: false,
          skipped: false,
        });
      }
    },
  );

  it('should not call disabled integration probes and rejects programmer faults', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-inspect-disabled-'),
    );
    const execute = vi.fn<Sprite['execFile']>(
      async (): Promise<ExecResult> => ({
        stdout: '[]',
        stderr: '',
        exitCode: 0,
      }),
    );
    const sprite = Object.assign(
      createFilesystemSprite({ root: directory.path, execute }),
      {
        listServices: vi.fn<Sprite['listServices']>(async () => [
          runningService,
        ]),
      },
    );
    serveServiceRegistry(sprite);
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
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
    const inspection = await inspectGuest(guestOf(sprite));

    expect(inspection.probeFailures).toEqual([]);
    expect(inspection.network).toMatchObject({ skipped: true });
    expect(inspection.hub).toMatchObject({ skipped: true });
    expect(
      execute.mock.calls.some(([, args]) => args?.includes('tailscale')),
    ).toBe(false);
    expect(
      execute.mock.calls.some(([, args]) => args?.includes('hub-probe.js')),
    ).toBe(false);

    execute.mockRejectedValue(new TypeError('invalid SDK shape'));
    await expect(inspectGuest(guestOf(sprite))).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});
