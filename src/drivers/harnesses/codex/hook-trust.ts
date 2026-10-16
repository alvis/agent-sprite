import { CommandFault } from '#errors';
import { HOME } from '#integrations/guest/account';
import { isRecord } from '#utilities/guards';

import { withCodexAppServer } from './app-server.js';
import { CODEX_HOOKS } from './paths.js';

import type { GuestChannel } from '#drivers/guest-channel';

import type { CodexRequest } from './app-server.js';

/** exact native hook identity used for trust and verification */
interface OwnedHook {
  key: string;
  currentHash: string;
  enabled: boolean;
  trustStatus: unknown;
}

/** one manager-owned hook: its event as `hooks/list` names it and its command */
interface ExpectedHook {
  eventName: string;
  command: string;
}

/**
 * trusts exactly open-agent's own user-level Codex hooks through one Codex
 * app server, then lists them again to verify each is enabled and trusted
 * @param guest target guest
 * @param commands each owned hook's command by its event, as `hooks.json` keys it
 * @throws {CommandFault} when Codex did not trust every owned hook
 */
export async function trustCodexHooks(
  guest: GuestChannel,
  commands: Readonly<Record<string, string>>,
): Promise<void> {
  // `hooks/list` names an event in camel case where `hooks.json` keys it in pascal case
  const expected = Object.entries(commands).map(([event, command]) => ({
    eventName: `${event.charAt(0).toLowerCase()}${event.slice(1)}`,
    command,
  }));
  try {
    await withCodexAppServer(guest, async (request) =>
      trustOwnedHooks(request, expected),
    );
  } catch (cause) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: 'Codex did not trust the managed awake hooks',
      cause,
    });
  }
}

/**
 * writes the trusted hash of every owned hook, then verifies the trust took
 * @param request sends one JSON-RPC call to the initialized app server
 * @param expected each owned hook's camel-case event and exact command
 * @throws {Error} when Codex refused the write or left a hook untrusted
 */
async function trustOwnedHooks(
  request: CodexRequest,
  expected: readonly ExpectedHook[],
): Promise<void> {
  const before = ownedHooks(
    await request('hooks/list', { cwds: [HOME] }),
    expected,
  );
  const write = await request('config/batchWrite', {
    edits: [
      {
        keyPath: 'hooks.state',
        value: Object.fromEntries(
          before.map((hook) => [hook.key, { trusted_hash: hook.currentHash }]),
        ),
        mergeStrategy: 'upsert',
      },
    ],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  });
  if (write.status !== 'ok' && write.status !== 'okOverridden') {
    throw new Error('Codex did not accept the managed hook trust update');
  }
  const after = ownedHooks(
    await request('hooks/list', { cwds: [HOME] }),
    expected,
  );
  if (!after.every((hook) => hook.enabled && hook.trustStatus === 'trusted')) {
    throw new Error('Manager-owned Codex hooks remain disabled or untrusted');
  }
}

/**
 * selects only the exact user hooks open-agent installed
 * @param result native hooks/list result
 * @param expected each owned hook's camel-case event and exact command
 * @returns exact owned hook records
 * @throws {Error} when an owned hook is missing or not unique
 */
function ownedHooks(
  result: Record<string, unknown>,
  expected: readonly ExpectedHook[],
): OwnedHook[] {
  const hooks = Array.isArray(result.data)
    ? result.data
        .filter(isRecord)
        .flatMap((item) =>
          Array.isArray(item.hooks) ? item.hooks.filter(isRecord) : [],
        )
    : [];

  return expected.map(({ eventName, command }) => {
    const matching = hooks.filter(
      (hook) =>
        hook.eventName === eventName &&
        hook.command === command &&
        hook.sourcePath === CODEX_HOOKS &&
        hook.source === 'user' &&
        hook.handlerType === 'command',
    );
    const [hook] = matching;
    if (
      matching.length !== 1 ||
      !hook ||
      typeof hook.key !== 'string' ||
      !hook.key ||
      typeof hook.currentHash !== 'string' ||
      !hook.currentHash
    ) {
      throw new Error(
        `Manager-owned Codex ${eventName} hook was not uniquely discovered`,
      );
    }

    return {
      key: hook.key,
      currentHash: hook.currentHash,
      enabled: Boolean(hook.enabled),
      trustStatus: hook.trustStatus,
    };
  });
}
