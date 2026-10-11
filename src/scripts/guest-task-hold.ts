import { createHash } from 'node:crypto';
import { request as requestHttp } from 'node:http';

import { isRecord } from './records.js';

const [mode, value, harness] = process.argv.slice(2);
const maxHookInputChars = 65_536;
let action = mode;
let encodedName = value;
if (mode === 'hook') {
  action = value;
  if (!harness || !['claude', 'codex'].includes(harness)) {
    process.exit(2);
  }
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > maxHookInputChars) {
      process.exit(2);
    }
  }
  const event: unknown = JSON.parse(input);
  if (
    !isRecord(event) ||
    typeof event.session_id !== 'string' ||
    !event.session_id
  ) {
    process.exit(2);
  }
  const identity = createHash('sha256').update(event.session_id).digest('hex');
  encodedName = `agent-sprite-${harness}-${identity}`;
}
const acquireStatus = 200;
const releaseStatus = 204;
const alreadyReleasedStatus = 404;
if (!action || !['acquire', 'release'].includes(action) || !encodedName) {
  process.exit(2);
}
const method = action === 'acquire' ? 'PUT' : 'DELETE';
const body = action === 'acquire' ? JSON.stringify({ expire: '30m' }) : '';
const request = requestHttp(
  {
    socketPath: '/.sprite/api.sock',
    host: 'sprite',
    path: `/v1/tasks/${encodedName}`,
    method,
    headers: {
      'Host': 'sprite',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 10_000,
  },
  (response) => {
    response.resume();
    response.on('end', () => {
      const success =
        action === 'acquire'
          ? response.statusCode === acquireStatus
          : response.statusCode === releaseStatus ||
            response.statusCode === alreadyReleasedStatus;
      process.exitCode = success ? 0 : 1;
    });
  },
);
request.on('timeout', () =>
  request.destroy(new Error('guest task hold timed out')),
);
request.on('error', () => {
  process.exitCode = 1;
});
request.end(body);
