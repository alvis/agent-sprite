import { CommandFault } from '#errors';
import { isRecord } from '#utilities/guards';

import { readGuestFile, writeGuestFile } from '../guest.js';

import { withGuestTransaction } from './transaction.js';

import type { Sprite } from '@fly/sprites';

import type {
  GuestIntegrations,
  GuestTailnetIdentity,
  GuestManifest,
} from './types.js';

const MANIFEST_PATH = '/opt/agent-sprite/manifest.json';
const SHARED_FILE_MODE = 0o644;

export type {
  GuestIntegrations,
  GuestTailnetIdentity,
  GuestManifest,
} from './types.js';

const LEGACY_INTEGRATIONS: GuestIntegrations = {
  tailscale: true,
  exitNode: true,
  cliproxyapi: true,
};

/**
 * revalidates input-dependent choices after the caller acquires guest ownership
 * @param sprite exact target guest
 * @param expected integration choices used to collect the current inputs
 * @throws {CommandFault} when another transaction changed those choices
 */
export async function assertGuestIntegrations(
  sprite: Sprite,
  expected: GuestIntegrations,
): Promise<void> {
  const fresh = guestIntegrations(await readGuestManifest(sprite));
  if (
    fresh.tailscale !== expected.tailscale ||
    fresh.exitNode !== expected.exitNode ||
    fresh.cliproxyapi !== expected.cliproxyapi
  ) {
    throw new CommandFault({
      code: 'CONFLICT',
      message:
        'Guest integration choices changed while inputs were collected; run the command again.',
    });
  }
}

/**
 * reads and validates the persistent guest installation manifest
 * @param sprite target guest
 * @returns validated schema-one manifest
 */
export async function readGuestManifest(
  sprite: Sprite,
): Promise<GuestManifest> {
  const manifest: unknown = JSON.parse(
    await readGuestFile(sprite, MANIFEST_PATH),
  );
  if (!isGuestManifest(manifest)) {
    throw new Error('Guest installation manifest is malformed');
  }

  return manifest;
}

/**
 * persists explicit direct-integration selections without replacing maintenance state
 * @param sprite target guest
 * @param integrations selected direct integrations
 */
export async function writeGuestIntegrations(
  sprite: Sprite,
  integrations: GuestIntegrations,
): Promise<void> {
  await withGuestTransaction(sprite, async () => {
    const manifest = await readGuestManifest(sprite);
    await writeGuestManifest(sprite, { ...manifest, integrations });
  });
}

/**
 * persists retained non-secret tailnet cleanup identity
 * @param sprite target guest
 * @param tailnetIdentity observed tailnet identity
 */
export async function writeGuestTailnetIdentity(
  sprite: Sprite,
  tailnetIdentity: GuestTailnetIdentity,
): Promise<void> {
  await withGuestTransaction(sprite, async () => {
    const manifest = await readGuestManifest(sprite);
    await writeGuestManifest(sprite, { ...manifest, tailnetIdentity });
  });
}

/**
 * normalizes legacy manifests to their historically enabled integrations
 * @param manifest validated guest manifest
 * @returns explicit integration selections
 */
export function guestIntegrations(manifest: GuestManifest): GuestIntegrations {
  return manifest.integrations ?? LEGACY_INTEGRATIONS;
}

/**
 * writes one schema-one manifest
 * @param sprite target guest
 * @param manifest complete guest manifest
 */
export async function writeGuestManifest(
  sprite: Sprite,
  manifest: GuestManifest,
): Promise<void> {
  await withGuestTransaction(sprite, async () => {
    await writeGuestFile(sprite, {
      path: MANIFEST_PATH,
      contents: `${JSON.stringify(manifest, null, 2)}\n`,
      mode: SHARED_FILE_MODE,
    });
  });
}

/**
 * checks whether a parsed value is a valid schema-one manifest
 * @param value candidate manifest
 * @returns true for a valid managed guest manifest
 */
function isGuestManifest(value: unknown): value is GuestManifest {
  return (
    isRecord(value) &&
    value.schema === 1 &&
    typeof value.createdAt === 'string' &&
    isRecord(value.installedVersions) &&
    Object.values(value.installedVersions).every(
      (version) => typeof version === 'string',
    ) &&
    (value.integrations === undefined ||
      (isRecord(value.integrations) &&
        typeof value.integrations.tailscale === 'boolean' &&
        typeof value.integrations.exitNode === 'boolean' &&
        typeof value.integrations.cliproxyapi === 'boolean')) &&
    (value.tailnetIdentity === undefined ||
      (isRecord(value.tailnetIdentity) &&
        (value.tailnetIdentity.deviceId === undefined ||
          typeof value.tailnetIdentity.deviceId === 'string') &&
        (value.tailnetIdentity.ip === undefined ||
          typeof value.tailnetIdentity.ip === 'string')))
  );
}
