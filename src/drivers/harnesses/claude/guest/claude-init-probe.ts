import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { isRecord, isStringArray } from '../../../../guest/records.js';

import {
  hasNoClaudePendingInteractions,
  isClaudeHookNotification,
} from './claude-init-notifications.js';

interface PendingResponse {
  id: string;
  resolve: (response: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

// deployed flat under the guest root, which is therefore this script's directory
const GUEST_ROOT = dirname(fileURLToPath(import.meta.url));
const home = '/home/agent';
const initializationTimeoutMs = 25_000;
const shutdownTimeoutMs = 2_000;
const maximumFrameChars = 1_048_576;
const selected: unknown = JSON.parse(
  await readFile(`${GUEST_ROOT}/claude-plugins.json`, 'utf8').catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }

      return '[]';
    },
  ),
);
if (!isStringArray(selected)) {
  throw new Error('Managed Claude plugin selection is malformed');
}
const child = spawn(
  `${home}/.local/bin/claude`,
  [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--setting-sources=user,project,local',
  ],
  {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: `${home}/.claude`,
      PATH: `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
let pending: PendingResponse | undefined;
let failure: Error | undefined;
let closing = false;
let closed = false;
let outputChars = 0;
const closure = new Promise<void>((resolve) => {
  child.once('close', (code) => {
    closed = true;
    if (!closing || (code !== 0 && code !== null)) {
      fail('Claude initialization process closed unexpectedly');
    }
    resolve();
  });
});
child.stderr.resume();
child.on('error', () => fail('Claude initialization process failed'));
child.stdin.on('error', () => fail('Claude initialization input failed'));
child.stdout.on('data', (chunk: Buffer) => {
  outputChars += chunk.length;
  if (outputChars > maximumFrameChars) {
    fail('Claude initialization output exceeded its limit');
  }
});
lines.on('line', receive);
lines.on('error', () => fail('Claude initialization output failed'));
const timeoutHandle = setTimeout(
  () => fail('Claude initialization timed out'),
  initializationTimeoutMs,
);
try {
  const initialized = await request('initialize');
  if (!Array.isArray(initialized.models)) {
    throw new Error('Claude initialization omitted model evidence');
  }
  const commands = names(initialized.commands);
  const agents = names(initialized.agents);
  let loadedPlugins: string[] = [];
  if (selected.length > 0) {
    const reloaded = await request('reload_plugins');
    if (
      !Array.isArray(reloaded.plugins) ||
      (reloaded.error_count !== undefined && reloaded.error_count !== 0)
    ) {
      throw new Error('Claude plugin reload failed');
    }
    loadedPlugins = reloaded.plugins.map((plugin: unknown) => {
      if (
        !isRecord(plugin) ||
        typeof plugin.source !== 'string' ||
        !plugin.source
      ) {
        throw new Error('Claude plugin reload omitted source evidence');
      }

      return plugin.source;
    });
  }
  await shutdown();
  if (failure) {
    throw failure;
  }
  process.stdout.write(
    JSON.stringify({
      initialized: true,
      modelCount: initialized.models.length,
      commands,
      agents,
      loadedPlugins,
      selectedPluginsLoaded: selected.every((identity) =>
        loadedPlugins.includes(identity),
      ),
    }),
  );
} finally {
  clearTimeout(timeoutHandle);
  await shutdown();
  lines.close();
}

/**
 * validates discovery names without manufacturing successful empty evidence
 * @param value native discovery array
 * @returns exact native names
 */
function names(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Claude initialization omitted discovery evidence');
  }

  return value.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name) {
      throw new Error(
        'Claude initialization returned malformed discovery evidence',
      );
    }

    return entry.name;
  });
}

/**
 * sends only supported control operations and never a conversation frame
 * @param subtype native initialization or plugin-discovery operation
 * @returns correlated native payload
 */
async function request(
  subtype: 'initialize' | 'reload_plugins',
): Promise<Record<string, unknown>> {
  if (failure) {
    throw failure;
  }

  return new Promise((resolve, reject) => {
    const id = randomUUID();
    pending = { id, resolve, reject };
    child.stdin.write(
      `${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } })}\n`,
    );
  });
}

/**
 * skips hook notifications and accepts only the outstanding control reply
 * @param line native NDJSON output
 */
function receive(line: string): void {
  try {
    const frame: unknown = JSON.parse(line);
    if (isClaudeHookNotification(frame)) {
      return;
    }
    if (
      !isRecord(frame) ||
      frame.type !== 'control_response' ||
      !isRecord(frame.response) ||
      frame.response.subtype !== 'success' ||
      frame.response.request_id !== pending?.id ||
      !pending ||
      !isRecord(frame.response.response) ||
      !hasNoClaudePendingInteractions(frame.response)
    ) {
      fail('Claude initialization returned an unexpected control response');

      return;
    }
    const response = pending;
    pending = undefined;
    response.resolve(frame.response.response);
  } catch {
    fail('Claude initialization returned malformed output');
  }
}

/**
 * retains safe protocol failure and stops the native process without approving requests
 * @param message fixed non-secret failure description
 */
function fail(message: string): void {
  failure ??= new Error(message);
  pending?.reject(failure);
  pending = undefined;
  child.kill('SIGTERM');
}

/** closes stdin and waits for bounded native process cleanup */
async function shutdown(): Promise<void> {
  closing = true;
  child.stdin.end();
  if (closed) {
    return;
  }
  const terminate = setTimeout(() => child.kill('SIGTERM'), shutdownTimeoutMs);
  const kill = setTimeout(() => child.kill('SIGKILL'), shutdownTimeoutMs * 2);
  try {
    await closure;
  } finally {
    clearTimeout(terminate);
    clearTimeout(kill);
  }
}
