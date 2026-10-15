import { isRecord, isStringArray } from './records.js';

// guest-side structural view of the host's WorkstationProfile (src/core/profile.ts).
// Guest code cannot import the host catalog, so driver ids stay plain strings;
// the host validates them against the catalog before writing the manifest.

/** options stored with the profile */
export interface StoredProfileOptions {
  isExitNodeEnabled: boolean;
  isProxyEnabled: boolean;
  idleTimeoutMinutes: number;
  holdMaxMinutes: number;
  updateDueIntervalDays: number;
  /** fewest CPUs the machine must provide */
  minCpus: number;
  /** least memory in whole gigabytes the machine must provide */
  minMemoryGb: number;
  /** release channel the agent follows, when the agent declares any */
  agentRelease?: string;
}

/** the workstation profile as stored in the guest manifest */
export interface StoredProfile {
  provider: string;
  agent: string;
  harnesses: string[];
  network: string;
  options: StoredProfileOptions;
}

const numericOptions = [
  'idleTimeoutMinutes',
  'holdMaxMinutes',
  'updateDueIntervalDays',
  'minCpus',
  'minMemoryGb',
] as const;

/**
 * checks that a decoded manifest field has the stored profile's structure
 * @param value untrusted decoded value
 * @returns whether every profile field has its declared type
 */
export function isStoredProfile(value: unknown): value is StoredProfile {
  if (!isRecord(value) || !isRecord(value.options)) {
    return false;
  }
  const { options } = value;

  return (
    typeof value.provider === 'string' &&
    typeof value.agent === 'string' &&
    isStringArray(value.harnesses) &&
    value.harnesses.length > 0 &&
    typeof value.network === 'string' &&
    typeof options.isExitNodeEnabled === 'boolean' &&
    typeof options.isProxyEnabled === 'boolean' &&
    numericOptions.every((key) => Number.isInteger(options[key])) &&
    (options.agentRelease === undefined ||
      typeof options.agentRelease === 'string')
  );
}
