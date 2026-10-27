import {
  guestFileExists,
  readGuestFile,
  writeGuestFile,
} from '#adapters/guest/platform/files';
import {
  ENVIRONMENT_PATH,
  UPDATE_STATUS_PATH,
} from '#adapters/guest/platform/layout';
import { parseUpdateStatus } from '#domain/observations/updates';
import { validateProfile } from '#domain/profile';
import { CommandFault } from '#kernel/faults';

import {
  ENVIRONMENT_MODE,
  parseEnvironment,
  serializeEnvironment,
} from './contracts';

import type { NetworkIdentityRecorder } from '#application/ports/drivers';
import type { GuestEnvironmentAccess } from '#application/ports/guest';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { ProductDeclarations } from '#domain/declarations';
import type { NetworkId } from '#domain/ids';
import type { GuestEnvironment } from '#domain/observations/environment';
import type { UpdateStatus } from '#domain/observations/updates';
import type { WorkstationProfile } from '#domain/profile';

/**
 * builds the access to the environment setup recorded on a guest
 * @param declarations the data every registered driver declares, which a recorded profile is checked against
 * @returns the environment reads and writes
 */
export function createEnvironmentAccess(
  declarations: ProductDeclarations,
): GuestEnvironmentAccess {
  const read = async (guest: GuestChannel): Promise<GuestEnvironment> =>
    readGuestEnvironment(declarations, guest);
  const write = async (
    guest: GuestChannel,
    environment: GuestEnvironment,
  ): Promise<void> => writeGuestEnvironment(declarations, guest, environment);

  return {
    read,
    find: async (guest) =>
      (await guestFileExists(guest, ENVIRONMENT_PATH))
        ? read(guest)
        : undefined,
    write,
    writeProfile: async (guest, profile) =>
      writeGuestProfile(declarations, guest, profile),
    identityRecorder: (guest, network) =>
      networkIdentityRecorder(declarations, guest, network),
    assertProfile: async (guest, expected) =>
      assertGuestProfile(declarations, guest, expected),
    readUpdateStatus,
  };
}

/**
 * reads the environment setup recorded on the guest
 * @param declarations the data every registered driver declares
 * @param guest target guest
 * @returns the record
 */
async function readGuestEnvironment(
  declarations: ProductDeclarations,
  guest: GuestChannel,
): Promise<GuestEnvironment> {
  return parseEnvironment(
    declarations,
    await readGuestFile(guest, ENVIRONMENT_PATH),
  );
}

/**
 * replaces the recorded environment atomically, readable by every account
 * @param declarations the data every registered driver declares
 * @param guest target guest
 * @param environment the record
 * @throws {CommandFault} when the record's profile is invalid
 */
async function writeGuestEnvironment(
  declarations: ProductDeclarations,
  guest: GuestChannel,
  environment: GuestEnvironment,
): Promise<void> {
  const validation = validateProfile({
    declarations,
    candidate: environment.profile,
  });
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
 * @param declarations the data every registered driver declares
 * @param guest target guest
 * @param profile the profile to record
 */
async function writeGuestProfile(
  declarations: ProductDeclarations,
  guest: GuestChannel,
  profile: WorkstationProfile,
): Promise<void> {
  const environment = await readGuestEnvironment(declarations, guest);
  await writeGuestEnvironment(declarations, guest, {
    ...environment,
    profile,
    schedule: { dueDays: profile.options.updateDueIntervalDays },
  });
}

/**
 * keeps a network device identity in the recorded environment, owned by the
 * network that enrolled it
 * @param declarations the data every registered driver declares
 * @param guest target guest
 * @param network the network whose device the identity names
 * @returns the recorder a network driver calls with each identity it observes
 */
function networkIdentityRecorder(
  declarations: ProductDeclarations,
  guest: GuestChannel,
  network: NetworkId,
): NetworkIdentityRecorder {
  return async (identity) => {
    const environment = await readGuestEnvironment(declarations, guest);
    await writeGuestEnvironment(declarations, guest, {
      ...environment,
      networkIdentity: { ...identity, network },
    });
  };
}

/**
 * refuses to go on when the recorded integration choices changed while
 * inputs were being collected
 * @param declarations the data every registered driver declares
 * @param guest target guest
 * @param expected the profile the inputs were collected for
 * @throws {CommandFault} when the network, exit node or gateway choice differs
 */
async function assertGuestProfile(
  declarations: ProductDeclarations,
  guest: GuestChannel,
  expected: WorkstationProfile,
): Promise<void> {
  const { profile } = await readGuestEnvironment(declarations, guest);
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
async function readUpdateStatus(
  guest: GuestChannel,
): Promise<UpdateStatus | undefined> {
  if (!(await guestFileExists(guest, UPDATE_STATUS_PATH))) {
    return undefined;
  }

  return parseUpdateStatus(await readGuestFile(guest, UPDATE_STATUS_PATH));
}
