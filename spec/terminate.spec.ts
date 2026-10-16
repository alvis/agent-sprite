import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { TAILSCALE_STATE_FILE } from '#drivers/networks/tailscale/service';
import { MANAGED_LABEL, SCHEMA_LABEL } from '#drivers/providers/sprite/labels';
import { InteractionExit } from '#navigation';
import { terminateWorkstation } from '#terminate';

import { environmentOf } from './fixtures/environment.js';
import {
  DISABLED_NETWORK_PROFILE,
  TAILSCALE_PROFILE,
} from './fixtures/profile.js';
import { createFilesystemSprite, providerOf } from './mocks/sprites.js';

import type { Sprite } from '@fly/sprites';

import type { CommandRequest } from '#command';

const environment = environmentOf(TAILSCALE_PROFILE);

/**
 * creates a verified provider target with actual isolated guest files
 * @param root disposable directory for guest and local inputs
 * @returns exact-target request and SDK-only provider boundary
 */
async function createTerminationBoundary(root: string): Promise<{
  sprite: Sprite;
  client: SpritesClient;
  request: CommandRequest;
}> {
  const execute = vi.fn<Sprite['execFile']>(async () => ({
    stdout: '',
    stderr: 'native status unavailable',
    exitCode: 1,
  }));
  const sprite = Object.assign(createFilesystemSprite({ root, execute }), {
    id: 'sprite-incomplete',
    organizationName: 'test-organization',
    labels: [MANAGED_LABEL, SCHEMA_LABEL],
  });
  const client = Object.assign(new SpritesClient('test-token'), {
    getSprite: vi.fn<SpritesClient['getSprite']>(async () => sprite),
    deleteSprite: vi.fn<SpritesClient['deleteSprite']>(async () => undefined),
  } satisfies Partial<SpritesClient>);
  const envPath = join(root, 'selected.env');
  await writeFile(
    envPath,
    ['OPEN_AGENT_NETWORK=none', 'CLIPROXYAPI_ENABLED=false', ''].join('\n'),
  );
  vi.stubEnv('TAILSCALE_API_KEY', '');
  const request = {
    command: 'terminate',
    machine: sprite.name,
    options: {
      envFile: envPath,
      yes: true,
      nonInteractive: true,
      localCredentials: false,
      github: false,
    },
  } satisfies CommandRequest;

  return { sprite, client, request };
}

describe('fn:terminateWorkstation', () => {
  it('should refuse a supplied name that differs from the ownership-verified Sprite before deletion', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-mismatch-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );

    await expect(
      terminateWorkstation(
        { ...request, machine: 'different-target' },
        providerOf(client),
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'CONFLICT',
        message: expect.stringMatching(
          /does not match the verified workstation/,
        ),
      }),
    );

    expect(client.getSprite).toHaveBeenCalledExactlyOnceWith(
      'different-target',
    );
    expect(sprite.filesystem().exists).not.toHaveBeenCalled();
    expect(client.deleteSprite).not.toHaveBeenCalled();
  });

  it('should delete a verified incomplete workstation without requiring an absent environment or enrollment state', async () => {
    for (const hasManifest of [false, true]) {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-terminate-incomplete-'),
      );
      const { sprite, client, request } = await createTerminationBoundary(
        directory.path,
      );
      if (hasManifest) {
        await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
        await sprite
          .filesystem()
          .writeJSON('/opt/open-agent/environment.json', environment);
      }

      const result = await terminateWorkstation(request, providerOf(client));

      expect(result).toMatchObject({
        command: 'terminate',
        ok: true,
        data: {
          workstation: { status: 'deleted', id: sprite.id, name: sprite.name },
          network: { status: 'no device identity recorded' },
        },
      });
      expect(client.deleteSprite).toHaveBeenCalledExactlyOnceWith(sprite.name);
      expect(sprite.execFile).not.toHaveBeenCalled();
    }
  });

  it('should skip network cleanup for a workstation that joined no private network', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-none-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
    await sprite.filesystem().writeJSON('/opt/open-agent/environment.json', {
      ...environment,
      profile: DISABLED_NETWORK_PROFILE,
    });

    const result = await terminateWorkstation(request, providerOf(client));

    expect(result).toMatchObject({
      command: 'terminate',
      ok: true,
      data: {
        workstation: { status: 'deleted', id: sprite.id, name: sprite.name },
        network: { status: 'no device identity recorded' },
      },
    });
    expect(client.deleteSprite).toHaveBeenCalledExactlyOnceWith(sprite.name);
    expect(sprite.execFile).not.toHaveBeenCalled();
  });

  it('should preserve disabled recorded identity and report required cleanup after Sprite deletion without an API token', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-disabled-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    const filesystem = sprite.filesystem();
    await filesystem.mkdir('/opt/open-agent', { recursive: true });
    await filesystem.mkdir(dirname(TAILSCALE_STATE_FILE), { recursive: true });
    await filesystem.writeFile(TAILSCALE_STATE_FILE, 'enrolled');
    await filesystem.writeJSON('/opt/open-agent/environment.json', {
      ...environment,
      profile: DISABLED_NETWORK_PROFILE,
      networkIdentity: {
        network: 'tailscale',
        deviceId: 'managed-node',
        ip: '100.100.100.1',
      },
    });

    const result = await terminateWorkstation(request, providerOf(client));

    expect(result).toMatchObject({
      command: 'terminate',
      ok: false,
      data: {
        workstation: { status: 'deleted', id: sprite.id, name: sprite.name },
        network: {
          status: 'cleanup required',
          deviceId: 'managed-node',
          address: '100.100.100.1',
        },
      },
      error: { code: 'INPUT' },
    });
    expect(client.deleteSprite).toHaveBeenCalledExactlyOnceWith(sprite.name);
    // the stopped daemon cannot report, so the recorded identity stands
    expect(sprite.execFile).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/sudo',
      ['-n', '-E', '--', '/opt/open-agent/tools/tailscale', 'status', '--json'],
      expect.any(Object),
    );
  });

  it('should delete the recorded device with the management credential of the recorded network', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-network-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('TAILSCALE_API_KEY', 'generated-management-key');
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
    await sprite.filesystem().writeJSON('/opt/open-agent/environment.json', {
      ...environment,
      networkIdentity: {
        network: 'tailscale',
        deviceId: 'managed-node',
        ip: '100.100.100.1',
      },
    });

    const result = await terminateWorkstation(request, providerOf(client));

    expect(result).toMatchObject({
      command: 'terminate',
      ok: true,
      data: {
        workstation: { status: 'deleted', id: sprite.id, name: sprite.name },
        network: { status: 'deleted', deviceId: 'managed-node' },
      },
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      new URL('https://api.tailscale.com/api/v2/device/managed-node'),
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer generated-management-key',
        }),
      }),
    );
  });

  it('should refuse deletion when enrollment state exists but native inspection cannot capture an identity', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-identity-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    await sprite
      .filesystem()
      .mkdir(dirname(TAILSCALE_STATE_FILE), { recursive: true });
    await sprite.filesystem().writeFile(TAILSCALE_STATE_FILE, 'enrolled');

    await expect(
      terminateWorkstation(request, providerOf(client)),
    ).rejects.toEqual(expect.objectContaining({ code: 'PREFLIGHT' }));

    expect(client.deleteSprite).not.toHaveBeenCalled();
    expect(sprite.execFile).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/sudo',
      ['-n', '-E', '--', '/opt/open-agent/tools/tailscale', 'status', '--json'],
      expect.any(Object),
    );
  });

  it('should refuse deletion when a deselected network kept enrollment state but no identity was recorded', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-deselected-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    const filesystem = sprite.filesystem();
    await filesystem.mkdir('/opt/open-agent', { recursive: true });
    await filesystem.mkdir(dirname(TAILSCALE_STATE_FILE), { recursive: true });
    await filesystem.writeFile(TAILSCALE_STATE_FILE, 'enrolled');
    await filesystem.writeJSON('/opt/open-agent/environment.json', {
      ...environment,
      profile: DISABLED_NETWORK_PROFILE,
    });

    await expect(
      terminateWorkstation(request, providerOf(client)),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'PREFLIGHT',
        message: expect.stringMatching(
          /device identity could not be captured/u,
        ),
      }),
    );

    expect(client.deleteSprite).not.toHaveBeenCalled();
  });

  it('should name the network that recorded the identity as owner after the workstation switched to none', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-recorded-owner-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    const filesystem = sprite.filesystem();
    await filesystem.mkdir('/opt/open-agent', { recursive: true });
    await filesystem.writeJSON('/opt/open-agent/environment.json', {
      ...environment,
      profile: DISABLED_NETWORK_PROFILE,
      networkIdentity: {
        network: 'tailscale',
        deviceId: 'managed-node',
        ip: '100.100.100.1',
      },
    });

    const result = await terminateWorkstation(request, providerOf(client));

    expect(result).toMatchObject({
      ok: false,
      data: {
        network: { status: 'cleanup required', deviceId: 'managed-node' },
      },
      error: {
        message: expect.stringMatching(/Tailscale device managed-node/u),
      },
    });
  });

  it('should retain the caught status parser failure as a private provider cause before deletion', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-probe-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    await sprite
      .filesystem()
      .mkdir(dirname(TAILSCALE_STATE_FILE), { recursive: true });
    await sprite.filesystem().writeFile(TAILSCALE_STATE_FILE, 'enrolled');
    vi.mocked(sprite.execFile).mockResolvedValueOnce({
      stdout: '{private-body',
      stderr: '',
      exitCode: 0,
    });

    await expect(
      terminateWorkstation(request, providerOf(client)),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'PROVIDER',
        cause: expect.any(SyntaxError),
        causeVisibility: 'private',
      }),
    );
    expect(client.deleteSprite).not.toHaveBeenCalled();
  });

  it('should preserve cancellation identity when the status probe is interrupted', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-cancel-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    await sprite
      .filesystem()
      .mkdir(dirname(TAILSCALE_STATE_FILE), { recursive: true });
    await sprite.filesystem().writeFile(TAILSCALE_STATE_FILE, 'enrolled');
    const cancelled = new InteractionExit('cancel');
    vi.mocked(sprite.execFile).mockRejectedValueOnce(cancelled);

    await expect(
      terminateWorkstation(request, providerOf(client)),
    ).rejects.toBe(cancelled);
    expect(client.deleteSprite).not.toHaveBeenCalled();
  });
});
