import { describe, expect, it, vi } from 'vitest';

import { assertSupportedRelease } from '#adapters/guest/release-guard';

import type { ProviderDriver } from '#application/ports/drivers';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { WorkstationRecord } from '#domain/workstation';

const WORKSTATION = {
  id: 'test',
  name: 'test',
  organization: 'test',
  state: 'running',
  metadata: { setup: 'incomplete', version: '999.0.0' },
} satisfies WorkstationRecord;

describe('fn:assertSupportedRelease', () => {
  it('should refuse metadata recorded by a newer release without opening the guest', async () => {
    const provider = {
      openGuest: async () => {
        throw new Error('must not open');
      },
    } satisfies Pick<ProviderDriver, 'openGuest'>;

    await expect(
      assertSupportedRelease(provider, WORKSTATION, 'metadata'),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      recorded: '999.0.0',
    });
  });

  it.each([
    { source: 'guest', code: 'PROVIDER' },
    { source: 'guest-or-metadata', code: 'CONFLICT' },
  ] as const)(
    'should honor $source policy when the guest record cannot be read',
    async ({ source, code }) => {
      const guest = {
        exec: vi.fn<GuestChannel['exec']>(async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'permission denied',
        })),
      } satisfies Partial<GuestChannel> as Partial<GuestChannel> as GuestChannel;
      const provider = {
        openGuest: async () => guest,
      } satisfies Pick<ProviderDriver, 'openGuest'>;

      await expect(
        assertSupportedRelease(provider, WORKSTATION, source),
      ).rejects.toMatchObject({
        code,
      });
    },
  );

  it.each([
    'not JSON',
    'null',
    '{"openAgent":null}',
    '{"openAgent":{"version":42}}',
  ])(
    'should tolerate a guest record with no readable release: %s',
    async (stdout) => {
      const guest = {
        exec: vi.fn<GuestChannel['exec']>(async () => ({
          exitCode: 0,
          stdout,
          stderr: '',
        })),
      } satisfies Partial<GuestChannel> as Partial<GuestChannel> as GuestChannel;
      const provider = {
        openGuest: async () => guest,
      } satisfies Pick<ProviderDriver, 'openGuest'>;

      await expect(
        assertSupportedRelease(provider, WORKSTATION, 'guest-or-metadata'),
      ).resolves.toBeUndefined();
    },
  );
});
