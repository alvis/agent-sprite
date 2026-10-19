import { projectFields, same } from './fields';

import type {
  ProfileOptions,
  WorkstationProfile,
  ProfileSummary,
} from '#domain/profile';

/** the driver selection a workstation recorded, without its options */
export interface ProfileSummaryOutput {
  provider: string;
  agent: string;
  harnesses: readonly string[];
  network: string;
}

/** numeric and boolean options a workstation recorded */
export interface ProfileOptionsOutput {
  isExitNodeEnabled: boolean;
  isProxyEnabled: boolean;
  idleTimeoutMinutes: number;
  holdMaxMinutes: number;
  updateDueIntervalDays: number;
  minCpus: number;
  minMemoryGb: number;
  agentRelease?: string;
}

/** driver selection and options a workstation recorded */
export interface ProfileOutput extends ProfileSummaryOutput {
  options: ProfileOptionsOutput;
}

/**
 * projects the driver selection
 * @param summary internal profile summary
 * @returns output profile summary
 */
export function projectProfileSummary(
  summary: ProfileSummary,
): ProfileSummaryOutput {
  return projectFields<ProfileSummary, ProfileSummaryOutput>(summary, {
    provider: same,
    agent: same,
    harnesses: same,
    network: same,
  });
}

/**
 * projects a recorded profile with its options
 * @param profile internal profile
 * @returns output profile
 */
export function projectProfile(profile: WorkstationProfile): ProfileOutput {
  return projectFields<WorkstationProfile, ProfileOutput>(profile, {
    provider: same,
    agent: same,
    harnesses: same,
    network: same,
    options: projectProfileOptions,
  });
}

/**
 * projects recorded profile options
 * @param options internal options
 * @returns output options
 */
export function projectProfileOptions(
  options: ProfileOptions,
): ProfileOptionsOutput {
  return projectFields<ProfileOptions, ProfileOptionsOutput>(options, {
    isExitNodeEnabled: same,
    isProxyEnabled: same,
    idleTimeoutMinutes: same,
    holdMaxMinutes: same,
    updateDueIntervalDays: same,
    minCpus: same,
    minMemoryGb: same,
    agentRelease: same,
  });
}
