import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { isRecord } from './records.js';

const selected: unknown = JSON.parse(
  await readFile('/opt/agent-sprite/codex-plugins.json', 'utf8').catch(
    () => '[]',
  ),
);
if (
  !Array.isArray(selected) ||
  !selected.every((value) => typeof value === 'string')
) {
  throw new Error('Managed Codex plugin selection is malformed');
}
const responseTimeoutMs = 15_000;
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
 * @param id request identity
 * @param method native RPC method
 * @param params native RPC parameters
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
    }, responseTimeoutMs);
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

try {
  await request(0, 'initialize', {
    clientInfo: {
      name: 'agent-sprite',
      title: 'Agent Sprite',
      version: '0.0.0',
    },
  });
  child.stdin.write(
    `${JSON.stringify({ method: 'initialized', params: {} })}\n`,
  );
  const result = await request(1, 'skills/list', {
    cwds: ['/home/agent'],
    forceReload: true,
  });
  const workspace = Array.isArray(result.data)
    ? result.data.filter(isRecord).find((item) => item.cwd === '/home/agent')
    : undefined;
  if (!workspace || !Array.isArray(workspace.skills)) {
    throw new Error('Native Codex workspace skill inventory is malformed');
  }
  const skills = workspace.skills
    .filter(isRecord)
    .filter(
      (skill) =>
        typeof skill.pluginId === 'string' && selected.includes(skill.pluginId),
    )
    .map((skill) => {
      if (
        typeof skill.name !== 'string' ||
        typeof skill.path !== 'string' ||
        typeof skill.pluginId !== 'string' ||
        typeof skill.enabled !== 'boolean'
      ) {
        throw new Error('Native Codex plugin skill identity is malformed');
      }

      return {
        pluginId: skill.pluginId,
        name: skill.name,
        path: skill.path,
        enabled: skill.enabled,
      };
    });
  process.stdout.write(`${JSON.stringify({ selected, skills })}\n`);
} finally {
  child.stdin.end();
  child.kill();
}
