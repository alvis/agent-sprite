import { isRecord } from '#utilities/guards';

import type { TailnetStatus } from './types';

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
