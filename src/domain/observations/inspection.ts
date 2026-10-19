import type { BootReport } from '#domain/observations/boot';
import type { HubStatus } from '#domain/observations/hub';
import type { NativeConfigurationInspection } from '#domain/observations/native';
import type { NetworkStatus } from '#domain/observations/network';
import type { GuestServiceState } from '#domain/services';

import type { GuestEnvironment } from './environment';
import type { GovernorReport } from './governor';
import type { UpdateStatus } from './updates';

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
