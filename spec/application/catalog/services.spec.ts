import { describe, expect, it } from 'vitest';

import { pairAgent, serviceLabels } from '#application/catalog/services';
import { registry } from '#composition/registry';

import type { GuestChannel } from '#application/ports/guest-channel';

describe('fn:pairAgent', () => {
  it('should reject pairing for a driver without pairing support', async () => {
    const driver = { ...registry.agents.t3 };
    delete driver.pair;
    const guest =
      {} satisfies Partial<GuestChannel> as Partial<GuestChannel> as GuestChannel;

    await expect(
      pairAgent({ agents: { t3: driver } }, guest, 't3'),
    ).rejects.toMatchObject({
      code: 'UNEXPECTED',
      message: expect.stringContaining('t3'),
    });
  });
});

describe('fn:serviceLabels', () => {
  it('should name no service for a network without a daemon', () => {
    expect(Object.values(serviceLabels(registry))).not.toContain('None');
    expect(serviceLabels(registry)).toHaveProperty('tailscaled', 'Tailscale');
  });
});
