import { runGuest, runGuestResult } from '#adapters/guest/platform/run';
import { sanitizeGuestDiagnostic } from '#kernel/diagnostics';
import { ensureError } from '#kernel/faults';
import { isRecord } from '#kernel/guards';
import { InteractionExit } from '#kernel/navigation';
import { checkOperation, runOperation } from '#kernel/operation';

import { tailscaleCommand } from './service';

import type { GuestChannel } from '#application/ports/guest-channel';

import type { TailnetStatus } from '#domain/observations/network';

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

    const failure = ensureError(error);

    return offlineTailnetStatus(
      failure === error ? failure.message : 'Tailscale status unavailable',
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
 * interprets native status and current network probes as one tailnet view
 * @param status parsed native Tailscale status object
 * @param network current route, DNS, and egress evidence
 * @param network.routeDevice routed device observed for a public address
 * @param network.dnsReady whether the public probe hostname resolved
 * @param network.egressIp observed public IPv4 address
 * @returns bounded current tailnet status
 */
export function parseTailnetStatus(
  status: Record<string, unknown>,
  network: Pick<TailnetStatus, 'routeDevice' | 'dnsReady' | 'egressIp'>,
): TailnetStatus {
  const self = isRecord(status.Self) ? status.Self : {};
  const exit = isRecord(status.ExitNodeStatus) ? status.ExitNodeStatus : {};
  const peers = isRecord(status.Peer) ? Object.values(status.Peer) : [];
  const selectedPeer = peers.find(
    (peer) => isRecord(peer) && peer.ID === exit.ID,
  );
  const peerAddresses = isRecord(selectedPeer)
    ? selectedPeer.TailscaleIPs
    : undefined;

  return {
    deviceId: typeof self.ID === 'string' && self.ID ? self.ID : undefined,
    ip: firstIpv4(self.TailscaleIPs),
    online: self.Online === true,
    exitNode: typeof exit.ID === 'string' ? exit.ID : undefined,
    exitNodeIp: firstIpv4(exit.TailscaleIPs ?? peerAddresses)?.split('/')[0],
    exitNodeName: peerName(selectedPeer),
    skipped: false,
    ...network,
  };
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

/**
 * extracts the first IPv4 address or prefix in a native address list
 * @param addresses candidate native address list
 * @returns IPv4 address or prefix when present
 */
function firstIpv4(addresses: unknown): string | undefined {
  return Array.isArray(addresses)
    ? addresses.find(
        (item): item is string =>
          typeof item === 'string' && item.includes('.'),
      )
    : undefined;
}

/**
 * extracts the selected native peer's display name
 * @param value native peer record
 * @returns DNS or host name when present
 */
function peerName(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.DNSName === 'string') {
    return value.DNSName.replace(/\.$/, '');
  }

  return typeof value.HostName === 'string' ? value.HostName : undefined;
}
