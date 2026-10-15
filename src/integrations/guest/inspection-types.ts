import type { NetworkStatus } from '#drivers/contracts';
import type { GuestServiceState } from '#drivers/guest-channel';
import type { HubStatus } from '#drivers/shared/cliproxyapi/hub';
import type { GovernorReport } from '#guest/idle/state';
import type { NativeConfigurationInspection } from '#integrations/native';

import type { GuestManifest } from './types.js';

/** current explicit guest inspection result */
export interface GuestInspection {
  services: GuestServiceState[];
  network: NetworkStatus;
  native?: NativeConfigurationInspection;
  hub: HubStatus;
  manifest: GuestManifest;
  probeFailures: InspectionProbeFailure[];
  /** the idle governor's recorded state, reported but never a readiness failure */
  governor: GovernorReport;
}

/** a live probe that could not establish its current guest state */
export interface InspectionProbeFailure {
  probe: 'services' | 'network' | 'native' | 'proxy';
  reason: string;
}
