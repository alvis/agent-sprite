import { describe, expect, it, vi } from 'vitest';

import { createGuestMechanics } from '#adapters/guest/mechanics';
import { ENVIRONMENT_PATH } from '#adapters/guest/platform/layout';
import { defaults } from '#composition/defaults';
import { registry } from '#composition/registry';

import { environmentOf } from '../../fixtures/environment';
import { profileWith } from '../../fixtures/profile';

import type { ProbeEvent } from '#application/ports/guest';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { BootReport } from '#domain/observations/boot';

const PROFILE = profileWith({
  network: false,
  exitNode: false,
  cliproxyapi: true,
});

/** guest boundary with the recorded setup and a reachable model catalogue */
function inspectionGuest(): GuestChannel {
  return {
    services: {
      list: async () => [],
      ensure: async () => undefined,
      stop: async () => true,
      remove: async () => undefined,
    },
    exec: async ({ arguments: args }) => ({
      exitCode: 0,
      stdout: args.includes('oa-hub') ? '204' : '[]',
      stderr: '',
    }),
    spawn: () => {
      throw new Error('Inspection does not open a streaming process');
    },
    exists: async (path) => path === ENVIRONMENT_PATH,
    read: async (path) => {
      if (path === ENVIRONMENT_PATH) {
        return JSON.stringify(environmentOf(PROFILE));
      }
      throw new Error(`Guest path unavailable: ${path}`);
    },
    assertUnrestrictedNetwork: async () => undefined,
  } satisfies GuestChannel;
}

describe('fn:createInspection', () => {
  it('should report an enabled gateway and provider boot evidence with completed probe events', async () => {
    const guest = inspectionGuest();
    const boot: BootReport = {
      status: 'ok',
      startedAt: '2026-10-26T00:00:00Z',
      durationMs: 70,
      unsuccessfulSteps: {},
      log: [],
    };
    const events: ProbeEvent[] = [];
    const inspectBoot = vi.fn(async () => boot);
    const inspection = createGuestMechanics({ registry, defaults }).inspection;

    const result = await inspection.inspect(guest, {
      provider: { inspectBoot },
      onProbe: (event) => {
        events.push(event);
      },
    });

    expect(result).toMatchObject({
      hub: { reachable: true, skipped: false, status: 204 },
      boot,
    });
    expect(events.filter(({ probe }) => probe === 'proxy')).toEqual([
      { probe: 'proxy', phase: 'started' },
      { probe: 'proxy', phase: 'completed', durationMs: expect.any(Number) },
    ]);
    expect(events.filter(({ probe }) => probe === 'boot')).toEqual([
      { probe: 'boot', phase: 'started' },
      { probe: 'boot', phase: 'completed', durationMs: expect.any(Number) },
    ]);
    expect(inspectBoot).toHaveBeenCalledExactlyOnceWith(guest);
  });

  it('should keep sibling inspection evidence when the provider boot record cannot be read', async () => {
    const guest = inspectionGuest();
    const events: ProbeEvent[] = [];
    const inspection = createGuestMechanics({ registry, defaults }).inspection;

    const result = await inspection.inspect(guest, {
      provider: {
        inspectBoot: async () => {
          throw new Error('Boot record unavailable');
        },
      },
      onProbe: (event) => {
        events.push(event);
      },
    });

    expect(result).toMatchObject({
      hub: { reachable: true, skipped: false, status: 204 },
    });
    expect(result).not.toHaveProperty('boot');
    expect(events.filter(({ probe }) => probe === 'boot')).toEqual([
      { probe: 'boot', phase: 'started' },
      { probe: 'boot', phase: 'failed', durationMs: expect.any(Number) },
    ]);
  });
});
