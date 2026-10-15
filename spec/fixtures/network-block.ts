import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execPath } from 'node:process';

import { execa } from 'execa';

import type { Result } from 'execa';

/** environment variable naming the file the hook appends each attempt to */
const ATTEMPT_LOG_VARIABLE = 'OPEN_AGENT_E2E_NETWORK_LOG';

/**
 * preloaded module that fails every outbound request and records it: http and
 * https requests, fetch, and net.connect; tls.connect and other TCP sockets
 * reach net.Socket.prototype.connect, which is blocked too, while local IPC
 * paths and data, blob and file fetches, such as the bundled layout engine,
 * pass through
 */
const NETWORK_BLOCK =
  'data:text/javascript,' +
  encodeURIComponent(`
    import { appendFileSync } from 'node:fs';
    import http from 'node:http';
    import https from 'node:https';
    import { syncBuiltinESMExports } from 'node:module';
    import net from 'node:net';
    const log = process.env.${ATTEMPT_LOG_VARIABLE};
    const block = (kind, target) => {
      appendFileSync(log, JSON.stringify({ kind, target: String(target) }) + '\\n');
      return new Error('outbound ' + kind + ' blocked by the e2e network hook');
    };
    const describe = (target) =>
      target?.href ?? target?.url ?? target?.host ?? target?.hostname ?? target?.port ?? target;
    for (const [kind, module] of [['http', http], ['https', https]]) {
      for (const method of ['request', 'get']) {
        module[method] = (target) => { throw block(kind, describe(target)); };
      }
    }
    const isLocalPath = (target) =>
      typeof target === 'string' ? Number.isNaN(Number(target)) : target?.path !== undefined && target?.port === undefined;
    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
      const [target] = Array.isArray(args[0]) ? args[0] : args;
      if (isLocalPath(target)) return connect.apply(this, args);
      throw block('socket', describe(target));
    };
    for (const method of ['connect', 'createConnection']) {
      const original = net[method];
      net[method] = (...args) => {
        if (isLocalPath(args[0])) return original(...args);
        const target = typeof args[0] === 'number' ? (args[1] ?? 'localhost') + ':' + args[0] : describe(args[0]);
        throw block('net.' + method, target);
      };
    }
    const fetchLocal = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(describe(input));
      if (['data:', 'blob:', 'file:'].includes(url.protocol)) return fetchLocal(input, init);
      throw block('fetch', url.href);
    };
    syncBuiltinESMExports();
  `);

/** one outbound attempt the hook blocked */
export interface NetworkAttempt {
  /** blocked entry point, such as fetch, https or socket */
  kind: string;
  /** requested URL or host */
  target: string;
}

/** a CLI run under the network block with every attempt it made */
export interface OfflineRun {
  /** CLI process result */
  result: Result<{ reject: false }>;
  /** every blocked outbound attempt in the order it was made */
  attempts: NetworkAttempt[];
}

/**
 * runs an executable with every outbound network request failed and recorded
 * @param file node entry to run, such as the installed bin
 * @param args arguments after the entry
 * @param context isolated working directory and environment
 * @param context.cwd working directory that also holds the attempt log
 * @param context.env complete child environment
 * @returns the process result and its recorded network attempts
 */
export async function runOffline(
  file: string,
  args: string[],
  context: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<OfflineRun> {
  const log = join(context.cwd, 'network-attempts.jsonl');
  const result = await execa(
    execPath,
    ['--import', NETWORK_BLOCK, file, ...args],
    {
      cwd: context.cwd,
      env: { ...context.env, [ATTEMPT_LOG_VARIABLE]: log },
      extendEnv: false,
      reject: false,
    },
  );
  const attempts = await readFile(log, 'utf8').then(
    (text) =>
      text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as NetworkAttempt),
    () => [],
  );

  return { result, attempts };
}
