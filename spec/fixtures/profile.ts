import { defaults } from '#composition/defaults';
import { registry } from '#composition/registry';
import { defaultProfile } from '#domain/profile';
import { summarizeProfile } from '#domain/recorded';
import { agentPort } from '#domain/services';

import type { ProfileSummary, WorkstationProfile } from '#domain/profile';

/** default profile of a workstation created without Tailscale */
export const DISABLED_NETWORK_PROFILE: WorkstationProfile = defaultProfile(
  defaults,
  'none',
);

/** ACP agent port of the default profile, which create declares to the provider */
export const DEFAULT_AGENT_PORT = agentPort(
  registry,
  DISABLED_NETWORK_PROFILE.agent,
);

/** default profile of a workstation created with Tailscale */
export const TAILSCALE_PROFILE: WorkstationProfile = defaultProfile(
  defaults,
  'tailscale',
);

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
  const profile = defaultProfile(
    defaults,
    integrations.network ? 'tailscale' : 'none',
  );

  return {
    ...profile,
    options: {
      ...profile.options,
      isExitNodeEnabled: integrations.exitNode,
      isProxyEnabled: integrations.cliproxyapi,
    },
  };
}
