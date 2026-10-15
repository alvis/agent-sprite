import type { ProfileSummary } from '#core/profile';

/** driver ids read from a provider's record, not yet checked against the registry */
export interface RecordedProfile {
  /** recorded provider driver id */
  provider: string;
  /** recorded ACP agent driver id */
  agent: string;
  /** recorded harness driver ids */
  harnesses: readonly string[];
  /** recorded network driver id */
  network: string;
}

/**
 * reduces a profile to the compact selection a provider records natively
 * @param profile validated workstation profile, options included or not
 * @returns driver ids without options
 */
export function summarizeProfile(profile: ProfileSummary): ProfileSummary {
  return {
    provider: profile.provider,
    agent: profile.agent,
    harnesses: [...profile.harnesses],
    network: profile.network,
  };
}
