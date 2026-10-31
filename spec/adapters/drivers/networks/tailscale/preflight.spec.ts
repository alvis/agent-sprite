import { describe, expect, it, vi } from 'vitest';

import {
  preflightTailscale,
  verifyTailscaleExitNode,
  issueTailscaleCredential,
} from '#adapters/drivers/networks/tailscale/preflight';

const boundary = vi.hoisted(
  () =>
    ({
      resolveExitNode: vi.fn<
        typeof import('#adapters/drivers/networks/tailscale/api').resolveExitNode
      >(async (_key, _account, selector) => ({
        id: 'home',
        name: selector,
        ip: '100.64.0.1',
      })),
      assertTailnetHostnameAvailable: vi.fn<
        typeof import('#adapters/drivers/networks/tailscale/api').assertTailnetHostnameAvailable
      >(async () => undefined),
      createTailscaleAuthKey: vi.fn<
        typeof import('#adapters/drivers/networks/tailscale/api').createTailscaleAuthKey
      >(async () => 'enrollment-key'),
    }) satisfies Partial<
      typeof import('#adapters/drivers/networks/tailscale/api')
    >,
);
vi.mock(
  '#adapters/drivers/networks/tailscale/api',
  () =>
    boundary satisfies Partial<
      typeof import('#adapters/drivers/networks/tailscale/api')
    >,
);
const management = { credential: 'test-key', account: 'example.ts.net' };

describe('fn:preflightTailscale', () => {
  it('should collect independent exit and hostname failures in check order', async () => {
    const exit = new Error('exit unavailable');
    const availability = new Error('hostname occupied');
    boundary.resolveExitNode.mockRejectedValueOnce(exit);
    boundary.assertTailnetHostnameAvailable.mockRejectedValueOnce(availability);

    expect(
      await preflightTailscale({
        hostname: 'workstation',
        management,
        exitNode: 'home',
      }),
    ).toEqual({ exitNode: undefined, problems: [exit, availability] });
  });

  it('should return the verified exit node after successful management checks', async () => {
    expect(
      await preflightTailscale({
        hostname: 'workstation',
        management,
        exitNode: 'home',
      }),
    ).toEqual({
      exitNode: { id: 'home', name: 'home', ip: '100.64.0.1' },
      problems: [],
    });
  });

  it.each([
    { hostname: 'workstation' },
    {
      hostname: 'workstation',
      management: { credential: 'test-key' },
      exitNode: 'home',
    },
    { hostname: 'workstation', management, exitNode: '' },
  ])(
    'should omit unavailable management checks for $management',
    async (params) => {
      expect(await preflightTailscale(params)).toEqual({
        exitNode: undefined,
        problems: [],
      });
    },
  );
});

describe('Tailscale management prerequisites', () => {
  it('should reject exit verification and credential issuance without a management account', async () => {
    await expect(
      verifyTailscaleExitNode({ credential: 'test-key' }, 'home'),
    ).rejects.toMatchObject({ code: 'INPUT' });
    await expect(
      issueTailscaleCredential({ credential: 'test-key' }),
    ).rejects.toMatchObject({ code: 'INPUT' });
  });

  it('should verify the selected exit node and issue a transient enrollment key', async () => {
    expect(await verifyTailscaleExitNode(management, 'home')).toEqual({
      id: 'home',
      name: 'home',
      ip: '100.64.0.1',
    });
    expect(await issueTailscaleCredential(management)).toBe('enrollment-key');
  });
});
