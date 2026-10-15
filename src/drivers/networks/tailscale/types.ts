import type { NetworkStatus } from '#drivers/contracts';

/** current tailnet identity and exit-route status */
export interface TailnetStatus extends NetworkStatus {
  /** whether a public hostname resolved */
  dnsReady: boolean;
}
