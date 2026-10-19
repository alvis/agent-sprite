import type { NetworkId } from '#domain/ids';

/** retained non-secret identity of an enrolled network device */
export interface NetworkIdentity {
  /** device identity at the network provider */
  deviceId?: string;
  /** network address of the device */
  ip?: string;
}

/** current private-network status of a workstation */
export interface NetworkStatus extends NetworkIdentity {
  /** whether the device is connected */
  online: boolean;
  /** whether the check was skipped because the network is not selected */
  skipped: boolean;
  /** bounded reason the status is unavailable */
  reason?: string;
  /** exit node the client currently routes through */
  exitNode?: string;
  /** IPv4 address of that exit node */
  exitNodeIp?: string;
  /** display name of that exit node */
  exitNodeName?: string;
  /** device the kernel routes public traffic through */
  routeDevice?: string;
  /** whether a public hostname resolved; reported by networks that route egress */
  dnsReady?: boolean;
  /** public IPv4 address observed from the guest */
  egressIp?: string;
}

/** retained non-secret network device identity for authorised cleanup */
export interface GuestNetworkIdentity extends NetworkIdentity {
  /** the network whose device this identity names, which stays owner after a switch */
  network: NetworkId;
}

/** current tailnet identity and exit-route status */
export interface TailnetStatus extends NetworkStatus {
  /** whether a public hostname resolved */
  dnsReady: boolean;
}

/** the status each registered network reports, keyed by network */
export interface NetworkStatuses {
  none: NetworkStatus;
  tailscale: TailnetStatus;
}
