import { describe, expect, it } from 'vitest';

import { assessReadiness } from '#readiness';

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
    manifest: {
      schema: 1,
      createdAt: '2026-10-14T00:00:00Z',
      installedVersions: {},
      profile: {
        ...profileWith({ network: false, exitNode: false, cliproxyapi: false }),
        provider,
      },
    },
    probeFailures: [],
    governor: { recorded: false, reason: 'not recorded' },
  };
}

describe('fn:assessReadiness maintenance schedule', () => {
  it('should check the supervisor timer, not cron, where the guest supervisor runs the services', () => {
    const running = assessReadiness(
      inspectionOf('fly-machine', [
        { name: 'open-agent-timer', status: 'running', needs: [] },
      ]),
    );
    const failed = assessReadiness(
      inspectionOf('fly-machine', [
        { name: 'open-agent-timer', status: 'failed', needs: [] },
        { name: 'open-agent-cron', status: 'running', needs: [] },
      ]),
    );

    expect({
      running: running.failures.filter((name) =>
        name.startsWith('maintenance'),
      ),
      failed: failed.failures.filter((name) => name.startsWith('maintenance')),
    }).toEqual({ running: [], failed: ['maintenance timer'] });
  });

  it('should check the cron service where the provider runs the services', () => {
    const missing = assessReadiness(
      inspectionOf('sprite', [
        { name: 'open-agent-timer', status: 'running', needs: [] },
      ]),
    );
    const running = assessReadiness(
      inspectionOf('sprite', [
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
  });
});
