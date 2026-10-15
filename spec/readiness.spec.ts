import { describe, expect, it } from 'vitest';

import { assessReadiness } from '#readiness';

import { environmentOf } from './fixtures/environment.js';
import { profileWith } from './fixtures/profile.js';

import type { ProviderId } from '#core/catalog';
import type { GuestServiceState } from '#drivers/guest-channel';
import type { GuestInspection } from '#integrations/guest/runtime';

/**
 * builds an inspection of a workstation on a provider with the given services
 * @param provider the selected provider
 * @param services the services the provider reported
 * @returns a complete inspection without a network or gateway
 */
function inspectionOf(
  provider: ProviderId,
  services: GuestServiceState[],
): GuestInspection {
  return {
    services,
    network: { online: false, skipped: true },
    hub: { reachable: false, skipped: true },
    environment: environmentOf({
      ...profileWith({ network: false, exitNode: false, cliproxyapi: false }),
      provider,
    }),
    probeFailures: [],
    governor: { recorded: false, reason: 'not recorded' },
  };
}

describe('fn:assessReadiness maintenance schedule', () => {
  it.each(['sprite', 'fly-machine'] as const)(
    'should check the cron service on %s',
    (provider) => {
      const missing = assessReadiness(inspectionOf(provider, []));
      const running = assessReadiness(
        inspectionOf(provider, [
          { name: 'open-agent-cron', status: 'running', needs: [] },
        ]),
      );

      expect({
        missing: missing.failures.filter((name) =>
          name.startsWith('maintenance'),
        ),
        running: running.failures.filter((name) =>
          name.startsWith('maintenance'),
        ),
      }).toEqual({ missing: ['maintenance cron service'], running: [] });
    },
  );
});
