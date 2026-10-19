import { runAsAgent } from '#adapters/guest/platform/account';
import { rememberSecret } from '#kernel/redaction';

import { T3_HOME } from './service';

import type { GuestChannel } from '#application/ports/guest-channel';
import type { AgentPairing } from '#domain/declarations';

/**
 * mints a new native T3 pairing credential without restarting its service
 * @param guest target guest
 * @returns fresh expiring T3 pairing credential
 */
export async function pairT3(guest: GuestChannel): Promise<AgentPairing> {
  const result = await runAsAgent(guest, [
    't3',
    'pair',
    '--base-dir',
    T3_HOME,
    '--ttl',
    '5m',
    '--label',
    'open-agent',
  ]);
  const outputLines = result.stdout.split('\n');
  const token = outputLines
    .find((line) => line.startsWith('Token:'))
    ?.slice('Token:'.length)
    .trim();
  const expiresAt = outputLines
    .find((line) => line.startsWith('Expires:'))
    ?.slice('Expires:'.length)
    .trim();
  if (!token) {
    throw new Error('T3 pairing command returned no parseable native token');
  }
  rememberSecret(token);

  return { token, expiresAt };
}
