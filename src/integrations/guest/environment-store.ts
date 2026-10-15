import { validateProfile } from '#core/profile';
import { CommandFault } from '#errors';

import { guestFileExists, readGuestFile, writeGuestFile } from '../guest.js';

import {
  ENVIRONMENT_MODE,
  ENVIRONMENT_PATH,
  parseEnvironment,
  serializeEnvironment,
} from './environment.js';
import { parseUpdateStatus, UPDATE_STATUS_PATH } from './updates.js';

import type { NetworkId } from '#core/catalog';
import type { WorkstationProfile } from '#core/profile';
import type { NetworkIdentityRecorder } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

import type { GuestEnvironment } from './environment.js';
import type { UpdateStatus } from './updates.js';

/**
 * reads the environment setup recorded on the guest
 * @param guest target guest
 * @returns the record
 * @throws {CommandFault} when its format version is unknown
 * @throws {Error} when it is missing or malformed
 */
export async function readGuestEnvironment(
  guest: GuestChannel,
): Promise<GuestEnvironment> {
  return parseEnvironment(await readGuestFile(guest, ENVIRONMENT_PATH));
}

/**
 * reads the environment setup recorded, when it recorded one
 * @param guest target guest
 * @returns the record, or nothing before setup first wrote it
 */
export async function findGuestEnvironment(
  guest: GuestChannel,
): Promise<GuestEnvironment | undefined> {
  return (await guestFileExists(guest, ENVIRONMENT_PATH))
    ? readGuestEnvironment(guest)
    : undefined;
}

/**
 * replaces the recorded environment atomically, readable by every account
 * @param guest target guest
 * @param environment the record
 * @throws {CommandFault} when the record's profile is invalid
 */
export async function writeGuestEnvironment(
  guest: GuestChannel,
  environment: GuestEnvironment,
): Promise<void> {
  const validation = validateProfile(environment.profile);
  if (!validation.isValid) {
    throw new CommandFault({
      code: 'INPUT',
      message: validation.violations.map(({ message }) => message).join('; '),
    });
  }
  await writeGuestFile(guest, {
    path: ENVIRONMENT_PATH,
    contents: serializeEnvironment(environment),
    mode: ENVIRONMENT_MODE,
  });
}

/**
 * records a profile whose change no tool, service or job follows, such as
 * the model gateway toggle or the update due interval
 * @param guest target guest
 * @param profile the profile to record
 */
export async function writeGuestProfile(
  guest: GuestChannel,
  profile: WorkstationProfile,
): Promise<void> {
  const environment = await readGuestEnvironment(guest);
  await writeGuestEnvironment(guest, {
    ...environment,
    profile,
    schedule: { dueDays: profile.options.updateDueIntervalDays },
  });
}

/**
 * keeps a network device identity in the recorded environment, owned by the
 * network that enrolled it
 * @param guest target guest
 * @param network the network whose device the identity names
 * @returns the recorder a network driver calls with each identity it observes
 */
export function networkIdentityRecorder(
  guest: GuestChannel,
  network: NetworkId,
): NetworkIdentityRecorder {
  return async (identity) => {
    const environment = await readGuestEnvironment(guest);
    await writeGuestEnvironment(guest, {
      ...environment,
      networkIdentity: { ...identity, network },
    });
  };
}

/**
 * refuses to go on when the recorded integration choices changed while
 * inputs were being collected
 * @param guest target guest
 * @param expected the profile the inputs were collected for
 * @throws {CommandFault} when the network, exit node or gateway choice differs
 */
export async function assertGuestProfile(
  guest: GuestChannel,
  expected: WorkstationProfile,
): Promise<void> {
  const { profile } = await readGuestEnvironment(guest);
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
 * reads what the updater recorded about its last run
 * @param guest target guest
 * @returns the record, or nothing when no update ran or it cannot be read
 */
export async function readUpdateStatus(
  guest: GuestChannel,
): Promise<UpdateStatus | undefined> {
  if (!(await guestFileExists(guest, UPDATE_STATUS_PATH))) {
    return undefined;
  }

  return parseUpdateStatus(await readGuestFile(guest, UPDATE_STATUS_PATH));
}
