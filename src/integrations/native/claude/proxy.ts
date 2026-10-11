import { CommandFault } from '#errors';

import {
  CLAUDE_PROXY_OWNERSHIP,
  captureOrRefreshOwnedValue,
  readOwnershipRecord,
  removeOwnershipRecord,
  restoreOwnedValue,
  writeOwnershipRecord,
} from '../proxy-ownership.js';
import { resolveProxyEndpoints } from '../proxy-url.js';

import type { Sprite } from '@fly/sprites';

import type {
  NativeProxyParams,
  OwnedConfigurationValue,
} from '../proxy-ownership.js';

const CLAUDE_PROXY_FIELDS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
] as const;

/** inputs for resolving Claude's optional managed proxy fields */
export type ClaudeProxyParams = NativeProxyParams<Record<string, unknown>>;

/** resolved Claude environment and deferred ownership cleanup state */
export interface ClaudeProxyResult {
  env: Record<string, unknown>;
  removeOwnership: boolean;
}

/**
 * resolves optional Claude proxy routing with private ownership evidence
 * @param params current settings and optional managed proxy values
 * @returns environment settings and whether cleanup follows the settings write
 */
export async function resolveClaudeProxy(
  params: ClaudeProxyParams,
): Promise<ClaudeProxyResult> {
  const { sprite, current, proxyUrl, apiKey } = params;
  const ownership = await readOwnershipRecord(
    sprite,
    CLAUDE_PROXY_OWNERSHIP,
    CLAUDE_PROXY_FIELDS,
  );
  if (
    apiKey &&
    current.ANTHROPIC_API_KEY &&
    current.ANTHROPIC_API_KEY !== apiKey
  ) {
    throw new CommandFault({
      code: 'CONFLICT',
      message:
        'Claude user settings contain a conflicting API-key authentication mechanism',
    });
  }
  if (!proxyUrl || !apiKey) {
    return {
      env: restoreManagedClaudeProxy(current, ownership),
      removeOwnership: Boolean(ownership),
    };
  }
  const managedValues = {
    ANTHROPIC_BASE_URL: resolveProxyEndpoints(proxyUrl).claude,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  };
  const fields = Object.fromEntries(
    CLAUDE_PROXY_FIELDS.map((key) => [
      key,
      captureOrRefreshOwnedValue({
        ownership: ownership?.[key],
        current,
        key,
        managedValue: managedValues[key],
      }),
    ]),
  );
  await writeOwnershipRecord(sprite, CLAUDE_PROXY_OWNERSHIP, fields);

  return { env: { ...current, ...managedValues }, removeOwnership: false };
}

/**
 * removes Claude ownership evidence after successful settings restoration
 * @param sprite target guest
 */
export async function removeClaudeProxyOwnership(
  sprite: Sprite,
): Promise<void> {
  await removeOwnershipRecord(sprite, CLAUDE_PROXY_OWNERSHIP);
}

/**
 * restores only unchanged manager-owned Claude routing values
 * @param current current Claude environment settings
 * @param ownership original and last managed field values
 * @returns environment settings with narrow restoration applied
 */
function restoreManagedClaudeProxy(
  current: Record<string, unknown>,
  ownership?: Record<
    (typeof CLAUDE_PROXY_FIELDS)[number],
    OwnedConfigurationValue
  >,
): Record<string, unknown> {
  if (!ownership) {
    return { ...current };
  }

  return CLAUDE_PROXY_FIELDS.reduce((restored, key) => {
    return restoreOwnedValue(restored, key, { ownership: ownership[key] });
  }, current);
}
