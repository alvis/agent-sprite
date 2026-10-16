import { parse } from 'smol-toml';

import { CommandFault } from '#errors';
import { guestFileExists, readGuestFile } from '#integrations/guest';
import {
  USER,
  HOME,
  asAgent,
  runAsAgent,
  ensurePrivateDirectory,
  writeOwnedFile,
  removeOwnedFile,
} from '#integrations/guest/account';
import { AGENT_PATH } from '#integrations/guest/layout';
import { isRecord } from '#utilities/guards';

import type { TomlTable } from 'smol-toml';

import type { GuestChannel } from '#drivers/guest-channel';

export {
  USER,
  HOME,
  AGENT_PATH,
  asAgent,
  runAsAgent,
  readJsonObject,
  readTomlObject,
  ensurePrivateDirectory,
  writeOwnedFile,
  removeOwnedFile,
  readSelectedPlugins,
  isRecord,
  isStringArray,
};

/**
 * reads an optional native JSON object without overwriting unrelated fields
 * @param guest target guest
 * @param path native configuration file
 * @returns parsed object, or an empty object for an absent file
 */
async function readJsonObject(
  guest: GuestChannel,
  path: string,
): Promise<Record<string, unknown>> {
  if (!(await guestFileExists(guest, path))) {
    return {};
  }
  const text = await readGuestFile(guest, path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new CommandFault({
      code: 'INPUT',
      message: `Native JSON configuration at ${path} is malformed`,
      cause,
      causeVisibility: 'private',
    });
  }
  if (!isRecord(parsed)) {
    throw new CommandFault({
      code: 'INPUT',
      message: `Native JSON configuration at ${path} is not an object`,
    });
  }

  return parsed;
}

/**
 * reads optional native TOML configuration
 * @param guest target guest
 * @param path native configuration file
 * @returns parsed TOML table, or an empty table for an absent file
 */
async function readTomlObject(
  guest: GuestChannel,
  path: string,
): Promise<TomlTable> {
  if (!(await guestFileExists(guest, path))) {
    return {};
  }

  const text = await readGuestFile(guest, path);
  try {
    return parse(text);
  } catch (cause) {
    throw new CommandFault({
      code: 'INPUT',
      message: `Native TOML configuration at ${path} is malformed`,
      cause,
      causeVisibility: 'private',
    });
  }
}

/**
 * reads open-agent's record of the plugin identities it manages for a harness
 * @param guest target guest
 * @param path harness's managed selection record
 * @returns selected native identities
 */
async function readSelectedPlugins(
  guest: GuestChannel,
  path: string,
): Promise<string[]> {
  if (!(await guestFileExists(guest, path))) {
    return [];
  }
  const text = await readGuestFile(guest, path);
  let selection: unknown;
  try {
    selection = JSON.parse(text);
  } catch (cause) {
    throw new CommandFault({
      code: 'PREFLIGHT',
      message: 'Managed native plugin selection record is malformed',
      cause,
      causeVisibility: 'private',
    });
  }
  if (!isStringArray(selection)) {
    throw new CommandFault({
      code: 'PREFLIGHT',
      message: 'Managed native plugin selection record is malformed',
    });
  }

  return selection;
}

/**
 * checks whether an unknown value is an array of strings
 * @param value candidate value
 * @returns true for a string array
 */
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}
