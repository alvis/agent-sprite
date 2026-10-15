import { runGuestResult } from '#integrations/guest';
import { checkOperation } from '#operation';
import { isRecord } from '#utilities/guards';

import { T3_HTTP_PORT } from './service.js';

import type { GuestChannel } from '#drivers/guest-channel';

/** what the running T3 service reports at its unauthenticated environment endpoint */
export type T3Environment =
  | {
      ok: true;
      /** version the running T3 server reports */
      serverVersion: string;
      /** environment label the server reports, which is the workstation name once the guest names itself after it */
      label?: string;
      /** orchestration protocol revision the server reports, when it does */
      orchestrationProtocolVersion?: number;
    }
  | {
      ok: false;
      /** bounded reason the endpoint did not answer as expected */
      reason: string;
    };

/** seconds curl waits for the endpoint */
const REQUEST_LIMIT_SECONDS = 5;
/** longest the whole guest command may take */
const PROBE_TIMEOUT_MS = 30_000;
const HTTP_OK = 200;
/** the endpoint, on the guest's loopback where the service listens */
const ENDPOINT = `http://127.0.0.1:${String(T3_HTTP_PORT)}/.well-known/t3/environment`;

/**
 * reads only the expected non-secret fields of the T3 environment endpoint:
 * one curl on the guest prints the body then the status on its own line
 * @param guest target guest
 * @returns validated environment evidence when the probe ran
 */
export async function inspectT3Environment(
  guest: GuestChannel,
): Promise<T3Environment | undefined> {
  let result: { exitCode: number; stdout: string };
  try {
    result = await runGuestResult(
      guest,
      [
        '/usr/bin/curl',
        '--silent',
        '--max-time',
        String(REQUEST_LIMIT_SECONDS),
        '--write-out',
        '\n%{http_code}',
        ENDPOINT,
      ],
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
  } catch {
    checkOperation();

    return undefined;
  }
  if (result.exitCode !== 0) {
    return { ok: false, reason: 'environment-endpoint-unreachable' };
  }
  const separator = result.stdout.lastIndexOf('\n');
  if (Number(result.stdout.slice(separator + 1).trim()) !== HTTP_OK) {
    return { ok: false, reason: 'environment-endpoint-status' };
  }

  return parseEnvironment(result.stdout.slice(0, Math.max(separator, 0)));
}

/**
 * validates the endpoint's body
 * @param body the response body
 * @returns the reported server version, label and protocol, or why the body is invalid
 */
function parseEnvironment(body: string): T3Environment {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    value = undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.serverVersion !== 'string' ||
    value.serverVersion === ''
  ) {
    return { ok: false, reason: 'environment-endpoint-invalid' };
  }

  return {
    ok: true,
    serverVersion: value.serverVersion,
    ...(typeof value.label === 'string' && value.label !== ''
      ? { label: value.label }
      : {}),
    ...(typeof value.orchestrationProtocolVersion === 'number'
      ? { orchestrationProtocolVersion: value.orchestrationProtocolVersion }
      : {}),
  };
}
