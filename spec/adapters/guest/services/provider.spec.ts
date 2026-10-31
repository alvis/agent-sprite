import { describe, expect, it, vi } from 'vitest';

import { installProviderServices } from '#adapters/guest/services/provider';

import type { GuestServiceControl } from '#application/ports/guest-channel';
import type { ServiceDefinition } from '#domain/services';

const control = {
  list: vi.fn<GuestServiceControl['list']>(async () =>
    ['base', 'removed', 'unrelated'].map((name) => ({
      name,
      status: 'running',
      needs: [],
    })),
  ),
  ensure: vi.fn<GuestServiceControl['ensure']>(async () => undefined),
  stop: vi.fn<GuestServiceControl['stop']>(async () => true),
  remove: vi.fn<GuestServiceControl['remove']>(async () => undefined),
} satisfies GuestServiceControl;
const base = {
  name: 'base',
  command: '/bin/base',
  arguments: [],
  account: 'root',
  needs: [],
} satisfies ServiceDefinition;
const dependent = {
  ...base,
  name: 'dependent',
  needs: ['base'],
} satisfies ServiceDefinition;

describe('fn:installProviderServices', () => {
  it('should install dependencies first and remove only previous services still present but no longer declared', async () => {
    await installProviderServices(
      control,
      [dependent, base],
      ['base', 'removed', 'already-gone'],
    );

    expect(control.ensure.mock.calls).toEqual([[base], [dependent]]);
    expect(control.stop.mock.calls).toEqual([['removed']]);
    expect(control.remove.mock.calls).toEqual([['removed']]);
    expect(control.stop.mock.invocationCallOrder[0]).toBeLessThan(
      control.remove.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    {
      reason: 'cycle',
      services: [{ ...base, needs: ['base'] }],
      message: /needs itself/u,
    },
    {
      reason: 'missing dependency',
      services: [{ ...base, needs: ['absent'] }],
      message: /not defined/u,
    },
  ])(
    'should reject invalid dependencies before changing services ($reason)',
    async ({ services, message }) => {
      await expect(
        installProviderServices(control, services, []),
      ).rejects.toThrow(message);
      expect(control.ensure).not.toHaveBeenCalled();
    },
  );
});
