import { spawn } from 'node:child_process';

import { isRecord } from '../../../../guest/records.js';

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

const rpcTimeoutMs = 15_000;
const verificationRequestId = 3;
const expectedHooks = expectedHooksOf(process.argv.slice(2));

const child = spawn(
  '/home/agent/.local/bin/codex',
  ['app-server', '--listen', 'stdio://'],
  {
    cwd: '/home/agent',
    env: { ...process.env, CODEX_HOME: '/home/agent/.codex' },
    stdio: ['pipe', 'pipe', 'ignore'],
  },
);
const pending = new Map<number, (message: Record<string, unknown>) => void>();
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  buffer += chunk;
  for (
    let newline = buffer.indexOf('\n');
    newline >= 0;
    newline = buffer.indexOf('\n')
  ) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message: unknown = JSON.parse(line);
    if (!isRecord(message) || typeof message.id !== 'number') {
      continue;
    }
    const waiting = pending.get(message.id);
    if (waiting) {
      pending.delete(message.id);
      waiting(message);
    }
  }
});

/**
 * requests one bounded native Codex app-server operation
 * @param id request identifier
 * @param method native method
 * @param params native method parameters
 * @returns successful RPC result
 */
async function request(
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex ${method} timed out`));
    }, rpcTimeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timeoutHandle);
      if (message.error) {
        reject(new Error(`Codex ${method} failed`));
      } else {
        if (!isRecord(message.result)) {
          reject(new Error('Codex returned an invalid RPC result'));
        } else {
          resolve(message.result);
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

/**
 * reads the manager-owned hooks from the arguments: pairs of a native hook
 * event name, as `hooks.json` keys it, and the exact command; `hooks/list`
 * names the same event in camel case
 * @param args event and command pairs
 * @returns each owned hook as `hooks/list` should report it
 */
function expectedHooksOf(args: readonly string[]): ExpectedHook[] {
  const hooks: ExpectedHook[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const [event, command] = [args[index], args[index + 1]];
    if (!event || !command) {
      break;
    }
    hooks.push({
      eventName: `${event.charAt(0).toLowerCase()}${event.slice(1)}`,
      command,
    });
  }
  if (hooks.length === 0 || hooks.length * 2 !== args.length) {
    throw new Error('Expected event and command pairs of manager-owned hooks');
  }

  return hooks;
}

/**
 * selects only the exact user hooks installed by this manager
 * @param result native hooks/list result
 * @returns exact owned hook records
 */
function ownedHooks(result: Record<string, unknown>): OwnedHook[] {
  const hooks = Array.isArray(result.data)
    ? result.data
        .filter(isRecord)
        .flatMap((item) =>
          Array.isArray(item.hooks) ? item.hooks.filter(isRecord) : [],
        )
    : [];

  return expectedHooks.map(({ eventName, command }) => {
    const matching = hooks.filter(
      (hook) =>
        hook.eventName === eventName &&
        hook.command === command &&
        hook.sourcePath === '/home/agent/.codex/hooks.json' &&
        hook.source === 'user' &&
        hook.handlerType === 'command',
    );
    const hook = matching[0];
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

try {
  await request(0, 'initialize', {
    clientInfo: {
      name: 'open-agent',
      title: 'Open Agent',
      version: '0.0.0',
    },
  });
  child.stdin.write(
    `${JSON.stringify({ method: 'initialized', params: {} })}\n`,
  );
  const before = ownedHooks(
    await request(1, 'hooks/list', { cwds: ['/home/agent'] }),
  );
  const trust = Object.fromEntries(
    before.map((hook) => [hook.key, { trusted_hash: hook.currentHash }]),
  );
  const write = await request(2, 'config/batchWrite', {
    edits: [{ keyPath: 'hooks.state', value: trust, mergeStrategy: 'upsert' }],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  });
  if (write.status !== 'ok' && write.status !== 'okOverridden') {
    throw new Error('Codex did not accept the managed hook trust update');
  }
  const after = ownedHooks(
    await request(verificationRequestId, 'hooks/list', {
      cwds: ['/home/agent'],
    }),
  );
  if (!after.every((hook) => hook.enabled && hook.trustStatus === 'trusted')) {
    throw new Error('Manager-owned Codex hooks remain disabled or untrusted');
  }
} finally {
  child.stdin.end();
  child.kill();
}
