import { describe, expect, it } from 'vitest';

import { assessReadiness } from '#application/readiness';

import { environmentOf } from '../fixtures/environment';
import { profileWith } from '../fixtures/profile';

import { dependencies } from '../mocks/dependencies';

import type { ProviderId } from '#domain/ids';
import type { GuestInspection } from '#domain/observations/inspection';
import type { GuestServiceState } from '#domain/services';

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
      const missing = assessReadiness(dependencies, inspectionOf(provider, []));
      const running = assessReadiness(
        dependencies,
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
