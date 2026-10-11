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

import { inspectGuest, installGuestTools } from '#integrations/guest/runtime';
import { assessReadiness } from '#readiness';

import { createFilesystemSprite } from '../../mocks/sprites.js';

import type { ExecResult, ServiceWithState, Sprite } from '@fly/sprites';

import type { ProgressUpdate } from '#command';

describe('fn:inspectGuest', () => {
  it('should report inspection stages while preserving disabled integrations and returned evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-sprite-inspect-'));
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
    try {
      await mkdir(join(root, 'opt/agent-sprite'), { recursive: true });
      await writeFile(
        join(root, 'opt/agent-sprite/manifest.json'),
        JSON.stringify({
          schema: 1,
          createdAt: '2026-10-07T00:00:00Z',
          lastSuccessfulUpdate: '2026-10-07T00:00:00Z',
          lastUpdateStatus: 'succeeded',
          installedVersions: {},
          integrations: {
            tailscale: false,
            exitNode: false,
            cliproxyapi: false,
          },
        }),
      );
      const inspection = await inspectGuest(sprite, (update) => {
        updates.push(update);
      });

      expect(inspection).toMatchObject({
        integrations: { tailscale: false, exitNode: false, cliproxyapi: false },
        services: [],
        tailscale: { skipped: true, online: false },
        hub: { skipped: true, reachable: false },
      });
      expect(updates[0]).toMatchObject({ stage: 'inspection' });
      const completed = updates.filter((update) => update.completed === 1);
      expect(completed.map((update) => update.stage).sort()).toEqual([
        'inspection',
        'native',
        'proxy',
        'services',
        'tailscale',
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
      join(tmpdir(), 'agent-sprite-install-versions-'),
    );
    const installer = Promise.withResolvers<ExecResult>();
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) =>
      args.includes('/opt/agent-sprite/install-tools.js')
        ? installer.promise
        : { stdout: 'test-version\n', stderr: '', exitCode: 0 },
    );
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute,
    });
    await sprite.filesystem().mkdir('/opt/agent-sprite', { recursive: true });

    const installation = installGuestTools(sprite);
    await vi.waitFor(() =>
      expect(
        execute.mock.calls.filter(([, args]) =>
          args?.includes('/opt/agent-sprite/install-tools.js'),
        ),
      ).toHaveLength(1),
    );
    expect(sprite.spawn).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      expect.arrayContaining(['agent-sprite-transaction', '1']),
      { tty: false },
    );
    expect(
      await sprite.filesystem().exists('/opt/agent-sprite/manifest.json'),
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
    expect(versionCalls).toHaveLength(9);
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
      '/usr/local/bin/node',
      '/usr/local/bin/git',
      '/usr/local/bin/jj',
      '/usr/local/bin/gh',
      '/usr/local/bin/tailscale',
      '/home/agent/.local/bin/claude',
      '/home/agent/.local/bin/codex',
      '/home/agent/.local/bin/t3',
      '/home/agent/.local/bin/bun',
    ]);
    expect(
      await sprite
        .filesystem()
        .readJSON<Record<string, unknown>>('/opt/agent-sprite/manifest.json'),
    ).toMatchObject({
      lastUpdateStatus: 'succeeded',
      installedVersions: { node: 'test-version' },
    });
  });

  it('should keep the initial manifest absent when the full installer fails after Node bootstrap', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-install-failure-'),
    );
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => ({
      stdout: '',
      stderr: '',
      exitCode: args.includes('/opt/agent-sprite/install-tools.js') ? 17 : 0,
    }));
    const sprite = createFilesystemSprite({ root: directory.path, execute });
    await sprite.filesystem().mkdir('/opt/agent-sprite', { recursive: true });

    await expect(installGuestTools(sprite)).rejects.toEqual(
      expect.objectContaining({ code: 'PROVIDER' }),
    );

    expect(
      execute.mock.calls.filter(([, args]) =>
        args?.includes('/opt/agent-sprite/install-tools.js'),
      ),
    ).toHaveLength(1);
    expect(
      execute.mock.calls.some(([, args]) =>
        args?.some((arg) => arg === '--version' || arg === 'version'),
      ),
    ).toBe(false);
    expect(
      await sprite.filesystem().exists('/opt/agent-sprite/manifest.json'),
    ).toBe(false);
  });
});

const runningService = {
  name: 't3-code',
  cmd: '/opt/agent-sprite/t3-launcher',
  args: [],
  needs: [],
  state: { name: 't3-code', status: 'running' },
} satisfies ServiceWithState;

describe('fn:inspectGuest independent probe failures', () => {
  it.each([
    { failed: 'services', proxy: false },
    { failed: 'native', proxy: false },
    { failed: 'proxy', proxy: true },
  ] as const)(
    'should retain fulfilled siblings when $failed fails',
    async ({ failed, proxy }) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'agent-sprite-inspect-failure-'),
      );
      const execute = vi.fn<Sprite['execFile']>(
        async (_file, args = []): Promise<ExecResult> => {
          if (
            (failed === 'native' &&
              args.includes('plugin') &&
              args.includes('list')) ||
            (failed === 'proxy' &&
              args.includes('/opt/agent-sprite/hub-probe.js'))
          ) {
            throw new Error(`${failed} SDK probe unavailable`);
          }

          return {
            stdout: args.includes('/opt/agent-sprite/hub-probe.js')
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
      await sprite.filesystem().mkdir('/opt/agent-sprite', { recursive: true });
      await sprite.filesystem().writeJSON('/opt/agent-sprite/manifest.json', {
        schema: 1,
        createdAt: '2026-10-09T00:00:00Z',
        installedVersions: {},
        integrations: {
          tailscale: false,
          exitNode: false,
          cliproxyapi: proxy,
        },
      });
      if (proxy) {
        await sprite
          .filesystem()
          .writeFile('/opt/agent-sprite/hub-probe.js', 'probe installed');
      }
      const progress: Array<{
        stage: string;
        message: string;
        completed?: number;
      }> = [];

      const inspection = await inspectGuest(sprite, (update) =>
        progress.push(update),
      );
      const readiness = assessReadiness(inspection);

      expect(inspection.probeFailures).toEqual([
        { probe: failed, reason: expect.stringContaining('unavailable') },
      ]);
      expect(readiness).toMatchObject({
        ready: false,
        failures: expect.arrayContaining([`${failed} inspection unavailable`]),
        probeFailures: inspection.probeFailures,
      });
      expect(inspection.tailscale).toMatchObject({ skipped: true });
      expect(progress).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: failed,
            message: expect.stringContaining('Check failed'),
          }),
          expect.objectContaining({ stage: 'tailscale', completed: 1 }),
        ]),
      );
      if (failed === 'services') {
        expect(inspection.services).toEqual([]);
        expect(inspection.native).toBeDefined();
      } else {
        expect(inspection.services).toEqual([runningService]);
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
      join(tmpdir(), 'agent-sprite-inspect-disabled-'),
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
    await sprite.filesystem().mkdir('/opt/agent-sprite', { recursive: true });
    await sprite.filesystem().writeJSON('/opt/agent-sprite/manifest.json', {
      schema: 1,
      createdAt: '2026-10-09T00:00:00Z',
      installedVersions: {},
      integrations: { tailscale: false, exitNode: false, cliproxyapi: false },
    });
    const inspection = await inspectGuest(sprite);

    expect(inspection.probeFailures).toEqual([]);
    expect(inspection.tailscale).toMatchObject({ skipped: true });
    expect(inspection.hub).toMatchObject({ skipped: true });
    expect(
      execute.mock.calls.some(([, args]) => args?.includes('tailscale')),
    ).toBe(false);
    expect(
      execute.mock.calls.some(([, args]) => args?.includes('hub-probe.js')),
    ).toBe(false);

    vi.mocked(sprite.listServices).mockRejectedValueOnce(
      new TypeError('invalid SDK shape'),
    );
    await expect(inspectGuest(sprite)).rejects.toBeInstanceOf(TypeError);
  });
});
