import { GUEST_ROOT } from '#guest/guest-root';
import {
  removeGuestFile,
  runGuestResult,
  writeGuestFile,
} from '#integrations/guest';

import { resolveProxyEndpoints } from './endpoints.js';

import type { ProxyRoute } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

/** non-billable current gateway reachability result */
export interface HubStatus {
  /** whether the gateway answered its model catalogue request */
  reachable: boolean;
  /** whether the check was skipped because the gateway is not selected */
  skipped: boolean;
  /** HTTP status the gateway answered with */
  status?: number;
  /** bounded reason the gateway could not be reached */
  reason?: string;
}

/** root's curl configuration naming the gateway's model catalogue and the client key it is asked with */
const HUB_RECORD = `${GUEST_ROOT}/cliproxyapi.curl`;
// the record holds the client key, so only root, which runs the probe, reads
// it, and the write hands it to the guest as a secret input
const HUB_RECORD_MODE = 0o600;
/** seconds curl waits for the gateway */
const REQUEST_LIMIT_SECONDS = 10;
/** longest the whole guest command may take */
const PROBE_TIMEOUT_MS = 30_000;
/** the probe's exit when no gateway is recorded */
const NO_RECORD = 64;
/** the HTTP statuses of a successful answer */
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 299;
/** the first printable character, and delete, the one control character above it */
const FIRST_PRINTABLE = 0x20;
const DELETE = 0x7f;
/**
 * asks the recorded gateway for its model catalogue as root, which alone
 * reads the record, printing only the HTTP status
 */
const HUB_PROBE = [
  `test -r "$1" || exit ${String(NO_RECORD)}`,
  `exec curl --silent --output /dev/null --max-time ${String(REQUEST_LIMIT_SECONDS)} --write-out '%{http_code}' --config "$1"`,
].join('\n');

/**
 * records the gateway the probe checks, or forgets it when routing is off
 * @param guest target guest
 * @param route CLIProxyAPI route, or undefined when no gateway is configured
 */
export async function recordHub(
  guest: GuestChannel,
  route: ProxyRoute | undefined,
): Promise<void> {
  if (!route) {
    await removeGuestFile(guest, HUB_RECORD);

    return;
  }
  await writeGuestFile(guest, {
    path: HUB_RECORD,
    contents: curlConfig({
      url: resolveProxyEndpoints(route.url).models,
      header: `Authorization: Bearer ${route.apiKey}`,
    }),
    mode: HUB_RECORD_MODE,
  });
}

/**
 * checks the recorded gateway's model catalogue without generating a model
 * turn: one curl on the guest, whose status the host reads
 * @param guest target guest
 * @returns gateway model-catalogue reachability
 */
export async function inspectHub(guest: GuestChannel): Promise<HubStatus> {
  const result = await runGuestResult(
    guest,
    ['/bin/sh', '-c', HUB_PROBE, 'oa-hub', HUB_RECORD],
    { timeoutMs: PROBE_TIMEOUT_MS },
  );
  if (result.exitCode === NO_RECORD) {
    return {
      reachable: false,
      skipped: false,
      reason: 'gateway record missing',
    };
  }
  if (result.exitCode !== 0) {
    return {
      reachable: false,
      skipped: false,
      reason: 'gateway request failed',
    };
  }
  const status = Number(result.stdout.trim());
  if (!Number.isInteger(status)) {
    throw new Error('Gateway readiness probe returned a malformed result');
  }

  return {
    reachable: status >= HTTP_SUCCESS_MIN && status <= HTTP_SUCCESS_MAX,
    skipped: false,
    status,
  };
}

/**
 * renders curl options as a configuration file, quoting each value
 * @param options option names and their values
 * @returns the configuration
 * @throws {Error} when a value holds a line break or another control character
 */
function curlConfig(options: Readonly<Record<string, string>>): string {
  return Object.entries(options)
    .map(([name, value]) => {
      if ([...value].some(isControlCharacter)) {
        throw new Error(`The gateway ${name} holds a control character`);
      }

      return `${name} = "${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"\n`;
    })
    .join('');
}

/**
 * tells whether a character is a control character, which a quoted curl
 * option value cannot hold
 * @param character one character
 * @returns true for a C0 control character or delete
 */
function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;

  return code < FIRST_PRINTABLE || code === DELETE;
}
