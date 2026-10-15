import type { NetworkId } from '#core/catalog';
import type { NetworkIdentity } from '#drivers/contracts';

import type { Secret } from './session/secret.js';

/** retained non-secret network device identity for authorised cleanup */
export interface GuestNetworkIdentity extends NetworkIdentity {
  /** the network whose device this identity names, which stays owner after a switch */
  network: NetworkId;
}

/** arguments for a bounded guest command */
export interface GuestRunOptions {
  input?: string;
  /** a credential the command receives instead of `input`, only over a setup session */
  secret?: {
    /** the credential */
    value: Secret;
    /** piped to standard input, or written to a private file named in `OPEN_AGENT_SECRET_FILE` */
    as: 'stdin' | 'shm-file';
  };
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
}
