import type { ServiceWithState } from '@fly/sprites';

import type { NativeConfigurationInspection } from '#integrations/native';

import type {
  TailnetStatus,
  GuestManifest,
  GuestIntegrations,
} from './types.js';

/** current explicit guest inspection result */
export interface GuestInspection {
  services: ServiceWithState[];
  tailscale: TailnetStatus;
  native?: NativeConfigurationInspection;
  hub: HubStatus;
  manifest: GuestManifest;
  integrations: GuestIntegrations;
  probeFailures: InspectionProbeFailure[];
}

/** a live probe that could not establish its current guest state */
export interface InspectionProbeFailure {
  probe: 'services' | 'tailscale' | 'native' | 'proxy';
  reason: string;
}

/** non-billable current gateway reachability result */
export interface HubStatus {
  reachable: boolean;
  skipped: boolean;
  status?: number;
  reason?: string;
}
