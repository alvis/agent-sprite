import { runGuest, runGuestResult } from '#integrations/guest';
import { sanitizeGuestDiagnostic } from '#integrations/guest/diagnostics';
import { InteractionExit } from '#navigation/exit';
import { checkOperation, runOperation } from '#operation';
import { isRecord } from '#utilities/guards';

import { tailscaleCommand } from './service.js';
import { parseTailnetStatus } from './status-parser.js';

import type { GuestChannel } from '#drivers/guest-channel';

import type { TailnetStatus } from './types.js';

const NETWORK_PROBE_TIMEOUT_MS = 10_000;
const EGRESS_PROBE_TIMEOUT_MS = 15_000;
const DIAGNOSTIC_LIMIT = 512;

/**
 * inspects the current Tailscale client without using cached status
 * @param guest target guest
 * @returns current tailnet identity, route, DNS, and egress status
 */
export async function inspectTailscale(
  guest: GuestChannel,
): Promise<TailnetStatus> {
  let result: Awaited<ReturnType<typeof runGuestResult>>;
  try {
    result = await runGuestResult(guest, tailscaleCommand('status', '--json'));
  } catch (error) {
    checkOperation();
    if (
      error instanceof InteractionExit ||
      error instanceof SyntaxError ||
      error instanceof TypeError ||
      error instanceof ReferenceError ||
      error instanceof RangeError
    ) {
      throw error;
    }

    return offlineTailnetStatus(
      error instanceof Error ? error.message : 'Tailscale status unavailable',
    );
  }
  if (result.exitCode !== 0) {
    return offlineTailnetStatus(
      `Tailscale status exited with status ${result.exitCode}: ${result.stderr}`,
    );
  }
  const status: unknown = JSON.parse(result.stdout);
  if (!isRecord(status)) {
    throw new Error('Tailscale returned a malformed status result');
  }

  const hasExitNode = isRecord(status.ExitNodeStatus);

  return parseTailnetStatus(
    status,
    hasExitNode ? await probeTailnetEgress(guest) : { dnsReady: false },
  );
}

/**
 * records a failed live status probe without implying a disabled integration
 * @param reason bounded guest or transport diagnostic
 * @returns offline, unskipped tailnet status
 */
function offlineTailnetStatus(reason: string): TailnetStatus {
  return {
    online: false,
    dnsReady: false,
    skipped: false,
    reason:
      sanitizeGuestDiagnostic(reason).slice(-DIAGNOSTIC_LIMIT) ||
      'Tailscale status unavailable',
  };
}

/**
 * checks DNS, the routed device, and public egress without accepting proxies
 * @param guest target guest
 * @returns current network probe evidence
 */
async function probeTailnetEgress(
  guest: GuestChannel,
): Promise<Pick<TailnetStatus, 'routeDevice' | 'dnsReady' | 'egressIp'>> {
  const [dns, egress] = await runOperation(async () =>
    Promise.allSettled([
      runGuest(guest, ['/usr/bin/getent', 'ahostsv4', 'api.ipify.org'], {
        timeoutMs: NETWORK_PROBE_TIMEOUT_MS,
      }),
      runGuest(
        guest,
        [
          '/usr/bin/env',
          '-u',
          'HTTPS_PROXY',
          '-u',
          'HTTP_PROXY',
          '-u',
          'ALL_PROXY',
          '/usr/bin/curl',
          '-4',
          '--fail',
          '--silent',
          '--show-error',
          '--max-time',
          '10',
          'https://api.ipify.org',
        ],
        { timeoutMs: EGRESS_PROBE_TIMEOUT_MS },
      ),
    ]),
  );
  const probeAddress =
    dns.status === 'fulfilled'
      ? dns.value.stdout.trim().split(/\s+/)[0]
      : undefined;
  // ip is found on the PATH, as the launcher finds it, since Homebrew's
  // iproute2 links it outside /usr/sbin
  const route = probeAddress
    ? await runGuest(guest, ['ip', '-4', 'route', 'get', probeAddress], {
        timeoutMs: NETWORK_PROBE_TIMEOUT_MS,
      }).catch(() => {
        checkOperation();

        return undefined;
      })
    : undefined;
  const egressIp =
    egress.status === 'fulfilled' ? egress.value.stdout.trim() : undefined;

  return {
    routeDevice: /\bdev\s+(\S+)/.exec(route?.stdout ?? '')?.[1],
    dnsReady: dns.status === 'fulfilled' && dns.value.stdout.trim().length > 0,
    egressIp: egressIp && /^[0-9.]+$/.test(egressIp) ? egressIp : undefined,
  };
}
