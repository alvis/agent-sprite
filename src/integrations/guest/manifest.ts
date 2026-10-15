import { isNetworkId } from '#core/networks';
import { parseProfile, validateProfile } from '#core/profile';
import { CommandFault } from '#errors';
import { isComponentOutcomes } from '#guest/component-outcome';
import { GUEST_ROOT } from '#guest/guest-root';
import { isRecord } from '#utilities/guards';

import { readGuestFile, writeGuestFile } from '../guest.js';

import { withGuestTransaction } from './transaction.js';

import type { NetworkId } from '#core/catalog';
import type { WorkstationProfile } from '#core/profile';
import type { NetworkIdentityRecorder } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

import type { GuestNetworkIdentity, GuestManifest } from './types.js';

const MANIFEST_PATH = `${GUEST_ROOT}/manifest.json`;
const SHARED_FILE_MODE = 0o644;
const MANIFEST_SCHEMA = 1;

export type { GuestNetworkIdentity, GuestManifest } from './types.js';

/**
 * revalidates input-dependent choices after the caller acquires guest ownership
 * @param guest exact target guest
 * @param expected profile whose choices were used to collect the current inputs
 * @throws {CommandFault} when another transaction changed those choices
 */
export async function assertGuestProfile(
  guest: GuestChannel,
  expected: WorkstationProfile,
): Promise<void> {
  const { profile } = await readGuestManifest(guest);
  if (
    profile.network !== expected.network ||
    profile.options.isExitNodeEnabled !== expected.options.isExitNodeEnabled ||
    profile.options.isProxyEnabled !== expected.options.isProxyEnabled
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
 * @param guest target guest
 * @returns validated schema-one manifest
 * @throws {CommandFault} when the manifest format version is unknown to this release
 */
export async function readGuestManifest(
  guest: GuestChannel,
): Promise<GuestManifest> {
  const manifest: unknown = JSON.parse(
    await readGuestFile(guest, MANIFEST_PATH),
  );
  if (
    isRecord(manifest) &&
    manifest.schema !== undefined &&
    manifest.schema !== MANIFEST_SCHEMA
  ) {
    throw new CommandFault({
      code: 'CONFLICT',
      message: `Guest manifest format version ${JSON.stringify(manifest.schema)} is not supported by this open-agent release; it was left unchanged`,
    });
  }
  if (!isGuestManifest(manifest)) {
    throw new Error('Guest installation manifest is malformed');
  }

  return manifest;
}

/**
 * persists a changed selection into the stored profile without replacing
 * maintenance state
 * @param guest target guest
 * @param profile selected profile
 */
export async function writeGuestProfile(
  guest: GuestChannel,
  profile: WorkstationProfile,
): Promise<void> {
  await withGuestTransaction(guest, async () => {
    const manifest = await readGuestManifest(guest);
    await writeGuestManifest(guest, { ...manifest, profile });
  });
}

/**
 * persists retained non-secret network cleanup identity with its owning network
 * @param guest target guest
 * @param networkIdentity observed network device identity and the network it belongs to
 */
export async function writeGuestNetworkIdentity(
  guest: GuestChannel,
  networkIdentity: GuestNetworkIdentity,
): Promise<void> {
  await withGuestTransaction(guest, async () => {
    const manifest = await readGuestManifest(guest);
    await writeGuestManifest(guest, { ...manifest, networkIdentity });
  });
}

/**
 * binds the network identity writer to one guest and the network that owns the device
 * @param guest target guest
 * @param network network whose device the recorded identity names
 * @returns recorder that persists the observed identity and its network in the manifest
 */
export function networkIdentityRecorder(
  guest: GuestChannel,
  network: NetworkId,
): NetworkIdentityRecorder {
  return async (identity) =>
    writeGuestNetworkIdentity(guest, { ...identity, network });
}

/**
 * writes one schema-one manifest
 * @param guest target guest
 * @param manifest complete guest manifest
 */
export async function writeGuestManifest(
  guest: GuestChannel,
  manifest: GuestManifest,
): Promise<void> {
  const validation = validateProfile(manifest.profile);
  if (!validation.isValid) {
    throw new CommandFault({
      code: 'INPUT',
      message: validation.violations.map(({ message }) => message).join('; '),
    });
  }
  await withGuestTransaction(guest, async () => {
    await writeGuestFile(guest, {
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
    value.schema === MANIFEST_SCHEMA &&
    typeof value.createdAt === 'string' &&
    isRecord(value.installedVersions) &&
    Object.values(value.installedVersions).every(
      (version) => typeof version === 'string',
    ) &&
    (value.componentOutcomes === undefined ||
      isComponentOutcomes(value.componentOutcomes)) &&
    parseProfile(value.profile).isValid &&
    (value.networkIdentity === undefined ||
      (isRecord(value.networkIdentity) &&
        typeof value.networkIdentity.network === 'string' &&
        isNetworkId(value.networkIdentity.network) &&
        (value.networkIdentity.deviceId === undefined ||
          typeof value.networkIdentity.deviceId === 'string') &&
        (value.networkIdentity.ip === undefined ||
          typeof value.networkIdentity.ip === 'string')))
  );
}
