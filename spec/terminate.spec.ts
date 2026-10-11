import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { MANAGED_LABEL, SCHEMA_LABEL } from '#integrations/sprites';
import { InteractionExit } from '#navigation';
import { terminateWorkstation } from '#terminate';

import { createFilesystemSprite } from './mocks/sprites.js';

import type { Sprite } from '@fly/sprites';

import type { CommandRequest } from '#command';
import type { GuestManifest } from '#integrations/guest/runtime';

const manifest = {
  schema: 1,
  createdAt: '2026-10-01T12:00:00Z',
  installedVersions: {},
  integrations: { tailscale: true, exitNode: false, cliproxyapi: false },
} satisfies GuestManifest;

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
    ['TAILSCALE_ENABLED=false', 'CLIPROXYAPI_ENABLED=false', ''].join('\n'),
  );
  vi.stubEnv('TAILSCALE_API_KEY', '');
  const request = {
    command: 'terminate',
    machine: sprite.name,
    options: {
      env: envPath,
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
      join(tmpdir(), 'agent-sprite-terminate-mismatch-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );

    await expect(
      terminateWorkstation({ ...request, machine: 'different-target' }, client),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'CONFLICT',
        message: expect.stringMatching(/does not match the verified Sprite/),
      }),
    );

    expect(client.getSprite).toHaveBeenCalledExactlyOnceWith(
      'different-target',
    );
    expect(sprite.filesystem().exists).not.toHaveBeenCalled();
    expect(client.deleteSprite).not.toHaveBeenCalled();
  });

  it('should delete a verified incomplete workstation without requiring an absent manifest or enrollment state', async () => {
    for (const hasManifest of [false, true]) {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'agent-sprite-terminate-incomplete-'),
      );
      const { sprite, client, request } = await createTerminationBoundary(
        directory.path,
      );
      if (hasManifest) {
        await sprite
          .filesystem()
          .mkdir('/opt/agent-sprite', { recursive: true });
        await sprite
          .filesystem()
          .writeJSON('/opt/agent-sprite/manifest.json', manifest);
      }

      const result = await terminateWorkstation(request, client);

      expect(result).toMatchObject({
        command: 'terminate',
        ok: true,
        data: {
          sprite: { status: 'deleted', id: sprite.id, name: sprite.name },
          tailnet: { status: 'no device identity recorded' },
        },
      });
      expect(client.deleteSprite).toHaveBeenCalledExactlyOnceWith(sprite.name);
      expect(sprite.execFile).not.toHaveBeenCalled();
    }
  });

  it('should preserve disabled recorded identity and report required cleanup after Sprite deletion without an API token', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-terminate-disabled-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    const filesystem = sprite.filesystem();
    await filesystem.mkdir('/opt/agent-sprite', { recursive: true });
    await filesystem.mkdir('/var/lib/tailscale', { recursive: true });
    await filesystem.writeFile(
      '/var/lib/tailscale/tailscaled.state',
      'enrolled',
    );
    await filesystem.writeJSON('/opt/agent-sprite/manifest.json', {
      ...manifest,
      integrations: { tailscale: false, exitNode: false, cliproxyapi: false },
      tailnetIdentity: { deviceId: 'managed-node', ip: '100.100.100.1' },
    });

    const result = await terminateWorkstation(request, client);

    expect(result).toMatchObject({
      command: 'terminate',
      ok: false,
      data: {
        sprite: { status: 'deleted', id: sprite.id, name: sprite.name },
        tailnet: {
          status: 'cleanup required',
          deviceId: 'managed-node',
          tailnetIp: '100.100.100.1',
        },
      },
      error: { code: 'INPUT' },
    });
    expect(client.deleteSprite).toHaveBeenCalledExactlyOnceWith(sprite.name);
    expect(sprite.execFile).not.toHaveBeenCalled();
  });

  it('should refuse deletion when enrollment state exists but native inspection cannot capture an identity', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-terminate-identity-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    await sprite.filesystem().mkdir('/var/lib/tailscale', { recursive: true });
    await sprite
      .filesystem()
      .writeFile('/var/lib/tailscale/tailscaled.state', 'enrolled');

    await expect(terminateWorkstation(request, client)).rejects.toEqual(
      expect.objectContaining({ code: 'PREFLIGHT' }),
    );

    expect(client.deleteSprite).not.toHaveBeenCalled();
    expect(sprite.execFile).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/sudo',
      [
        '-n',
        '-E',
        '--',
        '/opt/agent-sprite/tools/tailscale',
        'status',
        '--json',
      ],
      expect.any(Object),
    );
  });

  it('should retain the caught status parser failure as a private provider cause before deletion', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-terminate-probe-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    await sprite.filesystem().mkdir('/var/lib/tailscale', { recursive: true });
    await sprite
      .filesystem()
      .writeFile('/var/lib/tailscale/tailscaled.state', 'enrolled');
    vi.mocked(sprite.execFile).mockResolvedValueOnce({
      stdout: '{private-body',
      stderr: '',
      exitCode: 0,
    });

    await expect(terminateWorkstation(request, client)).rejects.toEqual(
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
      join(tmpdir(), 'agent-sprite-terminate-cancel-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    await sprite.filesystem().mkdir('/var/lib/tailscale', { recursive: true });
    await sprite
      .filesystem()
      .writeFile('/var/lib/tailscale/tailscaled.state', 'enrolled');
    const cancelled = new InteractionExit('cancel');
    vi.mocked(sprite.execFile).mockRejectedValueOnce(cancelled);

    await expect(terminateWorkstation(request, client)).rejects.toBe(cancelled);
    expect(client.deleteSprite).not.toHaveBeenCalled();
  });
});
