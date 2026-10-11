/** selected direct guest integrations */
export interface GuestIntegrations {
  tailscale: boolean;
  exitNode: boolean;
  cliproxyapi: boolean;
}

/** retained non-secret tailnet identity for authorised cleanup */
export interface GuestTailnetIdentity {
  deviceId?: string;
  ip?: string;
}

/** non-secret persistent installation and maintenance record */
export interface GuestManifest {
  schema: 1;
  createdAt: string;
  lastAttemptedUpdate?: string;
  lastSuccessfulUpdate?: string;
  lastUpdateStatus?: 'succeeded' | 'failed';
  lastUpdateError?: string;
  installedVersions: Record<string, string>;
  integrations?: GuestIntegrations;
  tailnetIdentity?: GuestTailnetIdentity;
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

/** current tailnet identity and exit-route status */
export interface TailnetStatus {
  deviceId?: string;
  ip?: string;
  online: boolean;
  exitNode?: string;
  exitNodeIp?: string;
  exitNodeName?: string;
  routeDevice?: string;
  dnsReady: boolean;
  egressIp?: string;
  skipped: boolean;
  reason?: string;
}
