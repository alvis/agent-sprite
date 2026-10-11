import { parse } from 'smol-toml';

import { CommandFault } from '#errors';
import { guestFileExists, readGuestFile } from '#integrations/guest';
import {
  USER,
  HOME,
  AGENT_PATH,
  runAsAgent,
  ensurePrivateDirectory,
  writeOwnedFile,
  removeOwnedFile,
  ownGuestFile,
} from '#integrations/guest/account';
import { isRecord } from '#utilities/guards';

import type { Sprite } from '@fly/sprites';
import type { TomlTable } from 'smol-toml';

export {
  USER,
  HOME,
  CLAUDE_SETTINGS,
  CODEX_CONFIG,
  CODEX_TOKEN,
  CLAUDE_PLUGIN_STATE,
  CODEX_PLUGIN_STATE,
  AGENT_PATH,
  runAsAgent,
  readJsonObject,
  readTomlObject,
  ensurePrivateDirectory,
  writeOwnedFile,
  removeOwnedFile,
  ownGuestFile,
  readSelectedPlugins,
  isRecord,
  isStringArray,
};

const CLAUDE_SETTINGS = `${HOME}/.claude/settings.json`;

const CODEX_CONFIG = `${HOME}/.codex/config.toml`;

const CODEX_TOKEN = `${HOME}/.codex/cliproxyapi-token`;

const CLAUDE_PLUGIN_STATE = '/opt/agent-sprite/claude-plugins.json';
const CODEX_PLUGIN_STATE = '/opt/agent-sprite/codex-plugins.json';

/**
 * reads an optional native JSON object without overwriting unrelated fields
 * @param sprite target guest
 * @param path native configuration file
 * @returns parsed object, or an empty object for an absent file
 */
async function readJsonObject(
  sprite: Sprite,
  path: string,
): Promise<Record<string, unknown>> {
  if (!(await guestFileExists(sprite, path))) {
    return {};
  }
  const text = await readGuestFile(sprite, path);
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
 * @param sprite target guest
 * @param path native configuration file
 * @returns parsed TOML table, or an empty table for an absent file
 */
async function readTomlObject(
  sprite: Sprite,
  path: string,
): Promise<TomlTable> {
  if (!(await guestFileExists(sprite, path))) {
    return {};
  }

  const text = await readGuestFile(sprite, path);
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
 * reads agent-sprite's selected Claude plugin identity record
 * @param sprite target guest
 * @param path managed selection record
 * @returns selected native identities
 */
async function readSelectedPlugins(
  sprite: Sprite,
  path: string,
): Promise<string[]> {
  if (!(await guestFileExists(sprite, path))) {
    return [];
  }
  const text = await readGuestFile(sprite, path);
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
