import type { NetworkId } from '#core/catalog';
import type { WorkstationProfile } from '#core/profile';
import type { NetworkIdentity } from '#drivers/contracts';
import type { ComponentOutcome } from '#guest/component-outcome';

/** retained non-secret network device identity for authorised cleanup */
export interface GuestNetworkIdentity extends NetworkIdentity {
  /** the network whose device this identity names, which stays owner after a switch */
  network: NetworkId;
}

/** non-secret persistent installation and maintenance record */
export interface GuestManifest {
  schema: 1;
  createdAt: string;
  lastAttemptedUpdate?: string;
  lastSuccessfulUpdate?: string;
  lastUpdateStatus?: 'succeeded' | 'failed';
  lastUpdateError?: string;
  /** why the update schedule runs on a fallback value, when it does */
  lastUpdateDiagnostic?: string;
  installedVersions: Record<string, string>;
  /** what the last install run did to each component */
  componentOutcomes?: Record<string, ComponentOutcome>;
  profile: WorkstationProfile;
  networkIdentity?: GuestNetworkIdentity;
}

/** arguments for a bounded guest command */
export interface GuestRunOptions {
  input?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  step?: string;
}

/** captured output of a successful guest command */
export interface GuestRunResult {
  stdout: string;
  stderr: string;
}

/** raw guest exit result for native commands with structured idempotent failures */
export interface GuestCommandResult extends GuestRunResult {
  exitCode: number;
}

/** destination, content, and permissions for an atomic guest file write */
export interface GuestFileParams {
  path: string;
  contents: string;
  mode?: number;
  removeOnRelease?: boolean;
}
