import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GuestPayload } from '#drivers/contracts';

/**
 * loads the payload assets against a guest leaf registry whose shared
 * component deploys the given modules
 * @param shared shared component modules, keyed by component folder
 * @returns the payload asset module
 */
async function assetsWith(
  shared: Record<string, readonly GuestPayload[]>,
): Promise<typeof import('#integrations/guest/payloads/assets')> {
  vi.resetModules();
  vi.doMock('#core/guest-leaves', async (importOriginal) => {
    const original =
      await importOriginal<typeof import('#core/guest-leaves')>();

    return {
      GUEST_LEAVES: {
        ...original.GUEST_LEAVES,
        shared: Object.fromEntries(
          Object.entries(shared).map(([id, guest]) => [id, { guest }]),
        ),
      },
    };
  });

  return import('#integrations/guest/payloads/assets');
}

afterEach(() => {
  vi.doUnmock('#core/guest-leaves');
  vi.resetModules();
});

describe('fn:compiledPayloads', () => {
  it('should list each registered guest module once', async () => {
    const { compiledPayloads } =
      await import('#integrations/guest/payloads/assets');

    const names = compiledPayloads();

    expect(new Set(names).size).toBe(names.length);
  });

  it('should refuse a driver module that would overwrite a core module', async () => {
    const { compiledPayloads } = await assetsWith({
      clash: [{ module: 'guest/records.js', account: 'root' }],
    });

    expect(() => compiledPayloads()).toThrow(
      'Guest module guest/records.js is outside the guest folder of shared/clash',
    );
  });

  it('should refuse a driver module inside another driver folder', async () => {
    const { compiledPayloads } = await assetsWith({
      intruder: [
        {
          module: 'drivers/shared/victim/guest/probe.js',
          account: 'agent',
        },
      ],
    });

    expect(() => compiledPayloads()).toThrow(
      'Guest module drivers/shared/victim/guest/probe.js is outside the guest folder of shared/intruder',
    );
  });

  it.each([
    [
      'a parent segment that stays inside the prefix',
      'drivers/shared/dots/guest/../guest/probe.js',
    ],
    [
      'a parent segment that leaves the folder',
      'drivers/shared/dots/guest/../../victim/guest/probe.js',
    ],
    ['a current-directory segment', 'drivers/shared/dots/guest/./probe.js'],
    ['a doubled separator', 'drivers/shared/dots/guest//probe.js'],
    ['an absolute name', '/drivers/shared/dots/guest/probe.js'],
  ])('should refuse a driver module with %s', async (_label, module) => {
    const { compiledPayloads } = await assetsWith({
      dots: [{ module, account: 'root' }],
    });

    expect(() => compiledPayloads()).toThrow(
      `Guest module ${module} is not a plain relative path`,
    );
  });

  it('should refuse a driver declaring the same module twice', async () => {
    const module = 'drivers/shared/twice/guest/probe.js';
    const { payloadUrl } = await assetsWith({
      twice: [
        { module, account: 'root' },
        { module, account: 'agent' },
      ],
    });

    expect(() => payloadUrl(module)).toThrow(
      `Guest module ${module} is deployed by more than one owner`,
    );
  });
});

describe('fn:payloadUrl', () => {
  it('should resolve a kernel module and a driver module to the compiled tree they mirror', async () => {
    const { payloadUrl } = await import('#integrations/guest/payloads/assets');

    expect(payloadUrl('guest/records.js').pathname).toMatch(
      /\/lib\/guest\/records\.js$/,
    );
    expect(
      payloadUrl('drivers/networks/tailscale/guest/tailscale-install.js')
        .pathname,
    ).toMatch(
      /\/lib\/drivers\/networks\/tailscale\/guest\/tailscale-install\.js$/,
    );
  });

  it('should refuse a module no owner deploys', async () => {
    const { payloadUrl } = await import('#integrations/guest/payloads/assets');

    expect(() => payloadUrl('records.js')).toThrow(
      'Unknown bundled guest payload',
    );
  });
});

describe('fn:payloadMode', () => {
  it('should give every deploy path the one mode its table entry names', async () => {
    const { payloadMode } = await import('#integrations/guest/payloads/assets');

    expect(
      [
        'guest/updater.js',
        'guest/update-schedule.js',
        'guest/install-tools.js',
        'guest/updater/executables.js',
      ].map(payloadMode),
    ).toEqual([0o700, 0o700, 0o700, 0o700]);
    expect(
      [
        'guest/native-files.js',
        'guest/component-catalog.js',
        'guest/idle/hook-input.js',
      ].map(payloadMode),
    ).toEqual([0o755, 0o755, 0o755]);
  });

  it('should take a driver module mode from the account its driver declares', async () => {
    const { payloadMode } = await import('#integrations/guest/payloads/assets');

    expect(
      payloadMode('drivers/networks/tailscale/guest/tailscale-launcher.js'),
    ).toBe(0o700);
    expect(
      payloadMode('drivers/networks/tailscale/guest/tailscale-state.js'),
    ).toBe(0o700);
    expect(payloadMode('drivers/agents/t3/guest/t3-environment-probe.js')).toBe(
      0o755,
    );
  });

  it('should deploy the Sprite awake adapter for the agent account and no hold module', async () => {
    const { payloadMode, compiledPayloads } =
      await import('#integrations/guest/payloads/assets');

    expect(payloadMode('drivers/providers/sprite/guest/sprite-awake.js')).toBe(
      0o755,
    );
    expect(compiledPayloads()).toContain(
      'drivers/providers/sprite/guest/sprite-awake.js',
    );
    expect(compiledPayloads()).not.toContain('guest/guest-task-hold.js');
    expect(compiledPayloads()).not.toContain('guest/updater-lifecycle.js');
  });

  it('should refuse a module no owner deploys', async () => {
    const { payloadMode } = await import('#integrations/guest/payloads/assets');

    expect(() => payloadMode('guest/unknown.js')).toThrow(
      'Unknown bundled guest payload',
    );
  });
});
