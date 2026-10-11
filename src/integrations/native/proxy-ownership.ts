import { CommandFault } from '#errors';
import { guestFileExists, readGuestFile } from '#integrations/guest';

import {
  HOME,
  ensurePrivateDirectory,
  isRecord,
  removeOwnedFile,
  writeOwnedFile,
} from './configuration.js';

import type { Sprite } from '@fly/sprites';

/** prior and last managed values for one manager-owned configuration field */
export interface OwnedConfigurationValue {
  previousPresent: boolean;
  previousValue?: unknown;
  managedValue: unknown;
}

/** Current native configuration and optional managed proxy inputs. */
export interface NativeProxyParams<Current> {
  sprite: Sprite;
  current: Current;
  proxyUrl?: string;
  apiKey?: string;
}

export const CLAUDE_PROXY_OWNERSHIP = `${HOME}/.config/agent-sprite/claude-proxy-ownership.json`;
export const CODEX_PROXY_OWNERSHIP = `${HOME}/.config/agent-sprite/codex-proxy-ownership.json`;

/**
 * captures a field's value before its first managed write
 * @param current current containing object
 * @param key managed field name
 * @param managedValue value the manager will write
 * @returns ownership evidence for later narrow restoration
 */
export function captureOwnedValue(
  current: Record<string, unknown>,
  key: string,
  managedValue: unknown,
): OwnedConfigurationValue {
  return {
    previousPresent: Object.hasOwn(current, key),
    previousValue: current[key],
    managedValue,
  };
}

/**
 * retains the original value while the current value remains manager-owned
 * @param params existing evidence, current field, and next managed value
 * @param params.ownership existing ownership evidence
 * @param params.current current containing object
 * @param params.key managed field name
 * @param params.managedValue replacement value the manager will write
 * @returns refreshed ownership evidence
 */
export function refreshOwnedValue(params: {
  ownership: OwnedConfigurationValue;
  current: Record<string, unknown>;
  key: string;
  managedValue: unknown;
}): OwnedConfigurationValue {
  const { ownership, current, key, managedValue } = params;

  return sameValue(current[key], ownership.managedValue)
    ? { ...ownership, managedValue }
    : captureOwnedValue(current, key, managedValue);
}

/**
 * Captures a new field or refreshes its existing ownership evidence.
 * @param params current value and optional existing ownership evidence
 * @param params.ownership original and managed values, if already present
 * @param params.current current containing object
 * @param params.key managed field name
 * @param params.managedValue new manager value
 * @returns ownership evidence retaining the original user value
 */
export function captureOrRefreshOwnedValue(params: {
  ownership?: OwnedConfigurationValue;
  current: Record<string, unknown>;
  key: string;
  managedValue: unknown;
}): OwnedConfigurationValue {
  const { ownership, current, key, managedValue } = params;

  return ownership
    ? refreshOwnedValue({ ownership, current, key, managedValue })
    : captureOwnedValue(current, key, managedValue);
}

/**
 * restores one field only while its current value remains manager-owned
 * @param current current containing object
 * @param key managed field name
 * @param params prior and managed values, with optional value guard
 * @param params.ownership prior and managed values
 * @param params.acceptsPreviousValue guard for persisted prior values
 * @returns cloned object with the narrow restoration applied
 */
export function restoreOwnedValue<Value>(
  current: Record<string, Value>,
  key: string,
  params: {
    ownership: OwnedConfigurationValue;
    acceptsPreviousValue: (value: unknown) => value is Value;
  },
): Record<string, Value>;
export function restoreOwnedValue(
  current: Record<string, unknown>,
  key: string,
  params: { ownership: OwnedConfigurationValue },
): Record<string, unknown>;
export function restoreOwnedValue(
  current: Record<string, unknown>,
  key: string,
  params: {
    ownership: OwnedConfigurationValue;
    acceptsPreviousValue?: (value: unknown) => boolean;
  },
): Record<string, unknown> {
  const { ownership, acceptsPreviousValue } = params;
  const restored = { ...current };
  if (!sameValue(current[key], ownership.managedValue)) {
    return restored;
  }
  if (
    ownership.previousPresent &&
    (!acceptsPreviousValue || acceptsPreviousValue(ownership.previousValue))
  ) {
    restored[key] = ownership.previousValue;
  } else {
    delete restored[key];
  }

  return restored;
}

/**
 * validates persisted ownership evidence at its guest trust boundary
 * @param value candidate ownership field
 * @returns true for complete ownership evidence
 */
export function isOwnedConfigurationValue(
  value: unknown,
): value is OwnedConfigurationValue {
  return (
    isRecord(value) &&
    typeof value.previousPresent === 'boolean' &&
    Object.hasOwn(value, 'managedValue')
  );
}

/**
 * reads an optional private ownership record
 * @param sprite target guest
 * @param path private ownership-record path
 * @param keys required harness-specific ownership fields
 * @returns parsed record when present
 */
export async function readOwnershipRecord<K extends string>(
  sprite: Sprite,
  path: string,
  keys: readonly K[],
): Promise<Record<K, OwnedConfigurationValue> | undefined> {
  if (!(await guestFileExists(sprite, path))) {
    return undefined;
  }
  const text = await readGuestFile(sprite, path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new CommandFault({
      code: 'PREFLIGHT',
      message: 'Managed proxy ownership record is malformed',
      cause,
      causeVisibility: 'private',
    });
  }
  if (!isRecord(parsed) || parsed.schema !== 1 || !isRecord(parsed.fields)) {
    throw new CommandFault({
      code: 'PREFLIGHT',
      message: 'Managed proxy ownership record is malformed',
    });
  }
  const fields = {} as Record<K, OwnedConfigurationValue>;
  for (const key of keys) {
    const field = parsed.fields[key];
    if (!isOwnedConfigurationValue(field)) {
      throw new CommandFault({
        code: 'PREFLIGHT',
        message: 'Managed proxy ownership record is malformed',
      });
    }
    fields[key] = field;
  }

  return fields;
}

/**
 * writes a private ownership record beside native user configuration
 * @param sprite target guest
 * @param path private ownership-record path
 * @param fields validated harness-specific ownership fields
 */
export async function writeOwnershipRecord(
  sprite: Sprite,
  path: string,
  fields: Record<string, OwnedConfigurationValue>,
): Promise<void> {
  await ensurePrivateDirectory(sprite, `${HOME}/.config/agent-sprite`);
  await writeOwnedFile(
    sprite,
    path,
    `${JSON.stringify({ schema: 1, fields }, null, 2)}\n`,
  );
}

/**
 * restores one private file only while its contents remain manager-owned
 * @param sprite target guest
 * @param path manager-specific private file path
 * @param ownership prior and managed file contents
 */
export async function restoreOwnedFile(
  sprite: Sprite,
  path: string,
  ownership: OwnedConfigurationValue,
): Promise<void> {
  const exists = await guestFileExists(sprite, path);
  const current = exists ? await readGuestFile(sprite, path) : undefined;
  if (!sameValue(current, ownership.managedValue)) {
    return;
  }
  if (
    ownership.previousPresent &&
    typeof ownership.previousValue === 'string'
  ) {
    await writeOwnedFile(sprite, path, ownership.previousValue);
  } else if (exists) {
    await removeOwnedFile(sprite, path);
  }
}

/**
 * removes an ownership record after successful narrow restoration
 * @param sprite target guest
 * @param path private ownership-record path
 */
export async function removeOwnershipRecord(
  sprite: Sprite,
  path: string,
): Promise<void> {
  if (await guestFileExists(sprite, path)) {
    await removeOwnedFile(sprite, path);
  }
}

/**
 * checks structural equality for JSON-compatible native configuration values
 * @param left current value
 * @param right last managed value
 * @returns whether the manager still owns the current value
 */
export function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
