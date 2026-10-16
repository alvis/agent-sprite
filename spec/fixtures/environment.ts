import { catalog } from '#core/catalog';
import { agentPort } from '#core/services';
import { ENVIRONMENT_SCHEMA } from '#integrations/guest/environment/contracts';
import { OPEN_AGENT_VERSION } from '#utilities/version';

import type { WorkstationProfile } from '#core/profile';
import type { GuestEnvironment } from '#integrations/guest/environment/contracts';

/**
 * builds the environment.json a finished setup of a profile records, with no
 * tools, jobs or network and only the agent's service
 * @param profile the recorded profile
 * @param overrides fields that differ from a ready setup
 * @returns a complete environment record
 */
export function environmentOf(
  profile: WorkstationProfile,
  overrides: Partial<GuestEnvironment> = {},
): GuestEnvironment {
  return {
    schema: ENVIRONMENT_SCHEMA,
    openAgent: { version: OPEN_AGENT_VERSION, setupAt: '2026-10-14T00:00:00Z' },
    setup: { state: 'ready', skipped: [] },
    os: { family: 'debian' },
    profile,
    tools: [],
    schedule: { dueDays: 7 },
    provider: {
      id: profile.provider,
      serviceBackend: 'provider',
      keepAwakeMode: 'none',
      idleForms: ['provider-managed'],
      wakeMode: 'url-traffic',
      supportsCliWakeSleep: false,
      maxAwakeDeadlineMinutes: null,
      transportNetworks: [],
      idleTimeoutMinutes: profile.options.idleTimeoutMinutes,
      holdMaxMinutes: profile.options.holdMaxMinutes,
      awakeAdapter: null,
    },
    agent: {
      id: profile.agent,
      service: catalog.agents[profile.agent].service.name,
      account: 'agent',
      port: agentPort(profile.agent),
      harnesses: [],
    },
    network: null,
    services: [catalog.agents[profile.agent].service],
    jobs: [],
    ...overrides,
  };
}
