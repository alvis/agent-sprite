import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { readComponentCatalog } from '../../../../guest/component-catalog.js';
import { readHarnessCatalog } from '../../../../guest/harness-catalog.js';

import { isRecord } from '../../../../guest/records.js';

const home = '/home/agent';
const environmentPath = `${home}/.config/open-agent/runtime-env.json`;
const runtimeEnvironment: unknown = JSON.parse(
  await readFile(environmentPath, 'utf8').catch(() => '{}'),
);
const committerPath = `${home}/.config/open-agent/committer.json`;
const committer: unknown = JSON.parse(
  await readFile(committerPath, 'utf8').catch(() => '{}'),
);
if (
  !isRecord(runtimeEnvironment) ||
  !Object.values(runtimeEnvironment).every(
    (value) => typeof value === 'string',
  ) ||
  !isRecord(committer)
) {
  throw new Error('Managed T3 environment is malformed');
}
const harnessEnvironment: Record<string, string> = Object.assign(
  {},
  ...(await readHarnessCatalog()).map((harness) => harness.environment),
);
const environment = Object.fromEntries(
  Object.entries(runtimeEnvironment).map(([name, value]) => [
    name,
    String(value),
  ]),
);
const child = spawn(
  `${home}/.local/bin/t3`,
  [
    'start',
    '--host',
    '0.0.0.0',
    '--port',
    String((await readComponentCatalog()).agent.httpPort),
    '--base-dir',
    `${home}/.t3`,
    '--no-browser',
    '--log-level',
    'warn',
  ],
  {
    cwd: home,
    env: {
      ...process.env,
      ...environment,
      HOME: home,
      ...harnessEnvironment,
      PATH: `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
      ...(typeof committer.name === 'string'
        ? { GIT_COMMITTER_NAME: committer.name }
        : {}),
      ...(typeof committer.email === 'string'
        ? { GIT_COMMITTER_EMAIL: committer.email }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

// t3 can mint startup credentials even when the browser is disabled; consume
// all child output so no token, pairing URL, or QR escapes into service logs.
child.stdout.resume();
child.stderr.resume();
child.on('error', () => {
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}
