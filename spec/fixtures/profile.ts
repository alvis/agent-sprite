import { defaultProfile } from '#core/profile';
import { agentPort } from '#core/services';
import { summarizeProfile } from '#drivers/providers/recorded';

import type { ProfileSummary, WorkstationProfile } from '#core/profile';

/** default profile of a workstation created without Tailscale */
export const DISABLED_NETWORK_PROFILE: WorkstationProfile =
  defaultProfile('none');

/** ACP agent port of the default profile, which create declares to the provider */
export const DEFAULT_AGENT_PORT = agentPort(DISABLED_NETWORK_PROFILE.agent);

/** default profile of a workstation created with Tailscale */
export const TAILSCALE_PROFILE: WorkstationProfile =
  defaultProfile('tailscale');

/** profile summary a default workstation without Tailscale records */
export const DISABLED_NETWORK_SUMMARY: ProfileSummary = summarizeProfile(
  DISABLED_NETWORK_PROFILE,
);

/** integration choices a test workstation selects */
export interface FixtureIntegrations {
  network: boolean;
  exitNode: boolean;
  cliproxyapi: boolean;
}

/**
 * builds the default profile with the given integration choices
 * @param integrations whether the private network, exit node and gateway are selected
 * @returns a complete workstation profile
 */
export function profileWith(
  integrations: FixtureIntegrations,
): WorkstationProfile {
  const profile = defaultProfile(integrations.network ? 'tailscale' : 'none');

  return {
    ...profile,
    options: {
      ...profile.options,
      isExitNodeEnabled: integrations.exitNode,
      isProxyEnabled: integrations.cliproxyapi,
    },
  };
}
