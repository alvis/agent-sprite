import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  readGuestManifest,
  writeGuestIntegrations,
  writeGuestTailnetIdentity,
} from '#integrations/guest/manifest';
import { mergeManifestUpdate as untypedMergeManifestUpdate } from '#scripts/update-manifest';
import { updateOptions as untypedUpdateOptions } from '#scripts/update-options';

import { createFilesystemSprite } from '../../mocks/sprites.js';

import type { GuestManifest } from '#integrations/guest/manifest';

const mergeManifestUpdate = untypedMergeManifestUpdate;
const updateOptions = untypedUpdateOptions as (
  manifest: GuestManifest,
  argv: string[],
) => { force: boolean; services: string[] };

describe('guest manifest transaction', () => {
  it('should merge fresh CLI and updater-owned fields on a real temporary file', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-manifest-transaction-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const guestPath = '/opt/agent-sprite/manifest.json';
    const hostPath = join(directory.path, guestPath);
    await sprite.filesystem().mkdir('/opt/agent-sprite', { recursive: true });
    await writeFile(
      hostPath,
      JSON.stringify({
        schema: 1,
        createdAt: '2026-01-01T00:00:00Z',
        installedVersions: { node: '24.0.0' },
      }),
    );

    await mergeManifestUpdate(hostPath, {
      installedVersions: { node: '24.1.0' },
      lastAttemptedUpdate: '2026-01-02T00:00:00Z',
      lastUpdateStatus: 'failed',
      lastUpdateError: 'bounded failure',
    });
    await writeGuestIntegrations(sprite, {
      tailscale: false,
      exitNode: false,
      cliproxyapi: true,
    });
    await writeGuestTailnetIdentity(sprite, { deviceId: 'device-1' });
    await mergeManifestUpdate(hostPath, {
      lastSuccessfulUpdate: '2026-01-03T00:00:00Z',
      lastUpdateStatus: 'succeeded',
    });

    const manifest = await readGuestManifest(sprite);
    expect(manifest).toMatchObject({
      installedVersions: { node: '24.1.0' },
      lastAttemptedUpdate: '2026-01-02T00:00:00Z',
      lastSuccessfulUpdate: '2026-01-03T00:00:00Z',
      lastUpdateStatus: 'succeeded',
      integrations: {
        tailscale: false,
        exitNode: false,
        cliproxyapi: true,
      },
      tailnetIdentity: { deviceId: 'device-1' },
    });
    expect(manifest).not.toHaveProperty('lastUpdateError');
    expect(JSON.parse(await readFile(hostPath, 'utf8'))).toEqual(manifest);
    expect(updateOptions(manifest, ['node', 'updater.js']).services).toEqual([
      't3-code',
    ]);
    expect(
      updateOptions(
        {
          ...manifest,
          integrations: { ...manifest.integrations!, tailscale: true },
        },
        ['node', 'updater.js', '--force'],
      ).services,
    ).toEqual(['t3-code', 'tailscaled']);
  });
});
