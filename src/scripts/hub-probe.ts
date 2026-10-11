import { readFile } from 'node:fs/promises';

import { isRecord } from './records.js';

const settings: unknown = JSON.parse(
  await readFile('/home/agent/.claude/settings.json', 'utf8'),
);
const environment =
  isRecord(settings) && isRecord(settings.env) ? settings.env : {};
const baseUrl = environment.ANTHROPIC_BASE_URL;
const token = environment.ANTHROPIC_AUTH_TOKEN;
const requestTimeoutMs = 10_000;
if (typeof baseUrl !== 'string' || typeof token !== 'string') {
  process.stdout.write(
    JSON.stringify({
      reachable: false,
      reason: 'native gateway settings missing',
    }),
  );
  process.exit(0);
}
try {
  const url = new URL('v1/models', `${baseUrl.replace(/\/$/, '')}/`);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  process.stdout.write(
    JSON.stringify({ reachable: response.ok, status: response.status }),
  );
} catch {
  process.stdout.write(
    JSON.stringify({ reachable: false, reason: 'gateway request failed' }),
  );
}
