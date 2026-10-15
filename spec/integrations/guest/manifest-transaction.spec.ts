import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { mergeManifestUpdate as untypedMergeManifestUpdate } from '#guest/update-manifest';
import { updateOptions } from '#guest/update-options';
import {
  readGuestManifest,
  writeGuestNetworkIdentity,
  writeGuestProfile,
} from '#integrations/guest/manifest';

import { profileWith, TAILSCALE_PROFILE } from '../../fixtures/profile.js';
import { createFilesystemSprite, guestOf } from '../../mocks/sprites.js';

const mergeManifestUpdate = untypedMergeManifestUpdate;

describe('guest manifest transaction', () => {
  it('should merge fresh CLI and updater-owned fields on a real temporary file', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-manifest-transaction-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const guestPath = '/opt/open-agent/manifest.json';
    const hostPath = join(directory.path, guestPath);
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
    await writeFile(
      hostPath,
      JSON.stringify({
        schema: 1,
        createdAt: '2026-01-01T00:00:00Z',
        installedVersions: { node: '24.0.0' },
        profile: TAILSCALE_PROFILE,
      }),
    );

    await mergeManifestUpdate(hostPath, {
      installedVersions: { node: '24.1.0' },
      lastAttemptedUpdate: '2026-01-02T00:00:00Z',
      lastUpdateStatus: 'failed',
      lastUpdateError: 'bounded failure',
    });
    await writeGuestProfile(
      guestOf(sprite),
      profileWith({ network: false, exitNode: false, cliproxyapi: true }),
    );
    await writeGuestNetworkIdentity(guestOf(sprite), {
      network: 'tailscale',
      deviceId: 'device-1',
    });
    await mergeManifestUpdate(hostPath, {
      lastSuccessfulUpdate: '2026-01-03T00:00:00Z',
      lastUpdateStatus: 'succeeded',
    });

    const manifest = await readGuestManifest(guestOf(sprite));
    expect(manifest).toMatchObject({
      installedVersions: { node: '24.1.0' },
      lastAttemptedUpdate: '2026-01-02T00:00:00Z',
      lastSuccessfulUpdate: '2026-01-03T00:00:00Z',
      lastUpdateStatus: 'succeeded',
      profile: {
        network: 'none',
        options: { isExitNodeEnabled: false, isProxyEnabled: true },
      },
      networkIdentity: { network: 'tailscale', deviceId: 'device-1' },
    });
    expect(manifest).not.toHaveProperty('lastUpdateError');
    expect(JSON.parse(await readFile(hostPath, 'utf8'))).toEqual(manifest);
    expect(updateOptions(['node', 'updater.js'])).toEqual({ force: false });
    expect(updateOptions(['node', 'updater.js', '--force'])).toEqual({
      force: true,
    });
  });
});
