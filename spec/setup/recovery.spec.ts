import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import {
  MANAGED_LABEL,
  SCHEMA_LABEL,
  SETUP_READY_LABEL,
} from '#integrations/sprites';
import { setupWorkstation } from '#setup';

import { createFilesystemSprite } from '../mocks/sprites.js';

import type { Sprite } from '@fly/sprites';

describe('setup recovery selection', () => {
  it.each([
    { ready: false, updaterCalls: 1, networkCalls: 0 },
    { ready: true, updaterCalls: 0, networkCalls: 1 },
  ])(
    'should use the real existing-manifest updater before tailnet setup only when READY is absent',
    async ({ ready, updaterCalls, networkCalls }) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'agent-sprite-setup-recovery-'),
      );
      const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => ({
        stdout: '',
        stderr: '',
        exitCode: args.includes('/opt/agent-sprite/updater.js') ? 17 : 0,
      }));
      const sprite = Object.assign(
        createFilesystemSprite({ root: directory.path, execute }),
        {
          id: 'sprite-recovery',
          organizationName: 'test-organization',
          labels: [
            MANAGED_LABEL,
            SCHEMA_LABEL,
            ...(ready ? [SETUP_READY_LABEL] : []),
          ],
        },
      );
      const network = vi
        .spyOn(sprite, 'getNetworkPolicy')
        .mockRejectedValue(new Error('network policy unavailable'));
      const services = vi
        .spyOn(sprite, 'listServices')
        .mockRejectedValue(new Error('unexpected service lookup'));
      vi.spyOn(sprite, 'update').mockImplementation(async (options) =>
        Object.assign(sprite, options),
      );
      const client = new SpritesClient('sdk-only-token');
      vi.spyOn(client, 'getSprite').mockResolvedValue(sprite);
      await sprite.filesystem().mkdir('/opt/agent-sprite', { recursive: true });
      await sprite.filesystem().writeJSON('/opt/agent-sprite/manifest.json', {
        schema: 1,
        createdAt: '2026-10-09T00:00:00Z',
        installedVersions: { node: '24.0.0' },
        integrations: {
          tailscale: true,
          exitNode: false,
          cliproxyapi: false,
        },
        tailnetIdentity: { deviceId: 'managed-device' },
      });

      const result = await setupWorkstation(
        {
          command: 'setup',
          machine: 'temporary',
          options: {
            section: 'all',
            tailnet: 'test-tailnet',
            github: false,
            gitIdentity: false,
            plugins: false,
            localCredentials: false,
            nonInteractive: true,
          },
        },
        client,
      );

      expect(result.ok).toBe(false);
      expect(
        execute.mock.calls.filter(([, args]) =>
          args?.includes('/opt/agent-sprite/updater.js'),
        ),
      ).toHaveLength(updaterCalls);
      expect(network).toHaveBeenCalledTimes(networkCalls);
      expect(services).not.toHaveBeenCalled();
      expect(sprite.spawn).toHaveBeenCalled();
    },
  );

  it('should use conservative bootstrap recovery when no manifest exists', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-setup-empty-'),
    );
    const execute = vi.fn<Sprite['execFile']>(async (_file, args = []) => ({
      stdout: '',
      stderr: '',
      exitCode: args.includes('/usr/bin/install') ? 17 : 0,
    }));
    const sprite = Object.assign(
      createFilesystemSprite({ root: directory.path, execute }),
      {
        id: 'sprite-empty',
        organizationName: 'test-organization',
        labels: [MANAGED_LABEL, SCHEMA_LABEL],
      },
    );
    vi.spyOn(sprite, 'listServices').mockRejectedValue(
      new Error('unexpected service lookup'),
    );
    vi.spyOn(sprite, 'getNetworkPolicy').mockRejectedValue(
      new Error('unexpected network policy lookup'),
    );
    vi.spyOn(sprite, 'update').mockImplementation(async (options) =>
      Object.assign(sprite, options),
    );
    const client = new SpritesClient('sdk-only-token');
    vi.spyOn(client, 'getSprite').mockResolvedValue(sprite);

    const result = await setupWorkstation(
      {
        command: 'setup',
        machine: 'temporary',
        options: {
          section: 'all',
          github: false,
          gitIdentity: false,
          plugins: false,
          localCredentials: false,
          nonInteractive: true,
        },
      },
      client,
    );

    expect(result.ok).toBe(false);
    expect(sprite.spawn).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      expect.arrayContaining(['agent-sprite-transaction', '1']),
      { tty: false },
    );
    expect(
      execute.mock.calls.some(([, args]) =>
        args?.includes('/opt/agent-sprite/updater.js'),
      ),
    ).toBe(false);
  });
});
