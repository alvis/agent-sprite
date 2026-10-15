import type { BootReport, NetworkStatus } from '#drivers/contracts';
import type { GuestServiceState } from '#drivers/guest-channel';
import type { HubStatus } from '#drivers/shared/cliproxyapi/hub';
import type { GovernorReport } from '#guest/idle/state';
import type { NativeConfigurationInspection } from '#integrations/native';

import type { GuestEnvironment } from './environment.js';
import type { UpdateStatus } from './updates.js';

/** current explicit guest inspection result */
export interface GuestInspection {
  services: GuestServiceState[];
  network: NetworkStatus;
  native?: NativeConfigurationInspection;
  hub: HubStatus;
  /** the environment setup recorded */
  environment: GuestEnvironment;
  /** what the updater recorded about its last run; absent before it ran */
  updates?: UpdateStatus;
  probeFailures: InspectionProbeFailure[];
  /** the idle governor's recorded state, reported but never a readiness failure */
  governor: GovernorReport;
  /** what the provider's boot hook recorded about the last boot; absent when it has none, or the inspection did not ask */
  boot?: BootReport;
}

/** a live probe that could not establish its current guest state */
export interface InspectionProbeFailure {
  probe: 'services' | 'network' | 'native' | 'proxy';
  reason: string;
}
