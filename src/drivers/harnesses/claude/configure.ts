import {
  ensurePrivateDirectory,
  isRecord,
  readJsonObject,
  writeOwnedFile,
} from '#integrations/native/configuration';

import { assertMergeableHooks } from '../shared/hooks.js';

import { CLAUDE_WORK_HOOKS } from './hooks.js';
import { CLAUDE_CONFIG_DIR, CLAUDE_SETTINGS } from './paths.js';
import { removeClaudeProxyOwnership, resolveClaudeProxy } from './proxy.js';

import type { HarnessConfigureParams } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

/**
 * applies the base environment and optional managed proxy routing to Claude user settings
 * @param guest target guest
 * @param params proxy routing to apply, or none to restore native authentication
 */
export async function configureClaude(
  guest: GuestChannel,
  params: HarnessConfigureParams,
): Promise<void> {
  await ensurePrivateDirectory(guest, CLAUDE_CONFIG_DIR);
  const current = await readJsonObject(guest, CLAUDE_SETTINGS);
  const previousEnv = isRecord(current.env) ? current.env : {};
  const proxy = await resolveClaudeProxy({
    guest,
    current: previousEnv,
    proxy: params.proxy,
  });
  // the hook installer runs next on this same file; refusing hooks it could
  // not merge now keeps the whole native update all-or-nothing
  assertMergeableHooks(current.hooks, CLAUDE_WORK_HOOKS);
  const next = {
    ...current,
    env: {
      ...proxy.env,
      DISABLE_AUTOUPDATER: '1',
    },
  };
  await writeOwnedFile(
    guest,
    CLAUDE_SETTINGS,
    `${JSON.stringify(next, null, 2)}\n`,
  );
  if (proxy.removeOwnership) {
    await removeClaudeProxyOwnership(guest);
  }
}
