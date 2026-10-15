import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  componentCatalog,
  harnessCatalogEntry,
  seedComponentCatalog,
} from '#core/guest-catalogs';
import { tailscaleGuestLeaf } from '#drivers/networks/tailscale/guest-leaf';
import { spriteGuestLeaf } from '#drivers/providers/sprite/guest-leaf';

import type {
  AcpAdapterSpec,
  GuestPayload,
  NetworkGuestLeaf,
  ProviderGuestLeaf,
} from '#drivers/contracts';
import type { ToolSpec } from '#tools/contracts';

/**
 * declares a fixture tool installed first from npm
 * @param name tool name, which is also its program
 * @param pkg npm package that provides it
 * @returns a required tool, probed as the agent with `--version`
 */
function npmTool(name: string, pkg: string): ToolSpec {
  return {
    name,
    required: true,
    executables: [name],
    version: { executable: name, args: ['--version'], account: 'agent' },
    sources: [{ kind: 'npm', package: pkg, account: 'agent' }],
  };
}

/**
 * loads the guest catalogs against a registry whose only network deploys the
 * given modules while naming the Tailscale installer
 * @param guest modules the network deploys
 * @returns the guest catalog module
 */
async function catalogsWith(
  guest: readonly GuestPayload[],
): Promise<typeof import('#core/guest-catalogs')> {
  vi.resetModules();
  vi.doMock('#core/guest-leaves', async (importOriginal) => {
    const original =
      await importOriginal<typeof import('#core/guest-leaves')>();
    const network: NetworkGuestLeaf = { ...tailscaleGuestLeaf, guest };

    return {
      GUEST_LEAVES: {
        ...original.GUEST_LEAVES,
        networks: { tailscale: network },
      },
    };
  });

  return import('#core/guest-catalogs');
}

/**
 * loads the guest catalogs against a registry whose Sprite provider declares
 * the given awake adapter
 * @param awakeAdapter the adapter the provider declares
 * @param keepAwakeMode the provider's keep-awake mode
 * @returns the guest catalog module
 */
async function catalogsWithAdapter(
  awakeAdapter: GuestPayload,
  keepAwakeMode: ProviderGuestLeaf['capabilities']['keepAwakeMode'] = 'native-deadline',
): Promise<typeof import('#core/guest-catalogs')> {
  vi.resetModules();
  vi.doMock('#core/guest-leaves', async (importOriginal) => {
    const original =
      await importOriginal<typeof import('#core/guest-leaves')>();
    const sprite: ProviderGuestLeaf = {
      ...spriteGuestLeaf,
      capabilities: { ...spriteGuestLeaf.capabilities, keepAwakeMode },
      awakeAdapter,
    };

    return {
      GUEST_LEAVES: {
        ...original.GUEST_LEAVES,
        providers: { ...original.GUEST_LEAVES.providers, sprite },
      },
    };
  });

  return import('#core/guest-catalogs');
}

afterEach(() => {
  vi.doUnmock('#core/guest-leaves');
  vi.resetModules();
});

describe('fn:seedComponentCatalog', () => {
  it('should manage no provider shell account before the host records the selected provider', () => {
    const seed = seedComponentCatalog();

    expect(seed.shellAccounts).toEqual([]);
    expect(seed.agent.id).toBe('t3');
    expect(seed.networks).toEqual([]);
  });
});

describe('fn:componentCatalog', () => {
  it('should carry the selected provider shell accounts and the selected network installer', () => {
    const catalog = componentCatalog({
      provider: 'sprite',
      agent: 't3',
      network: 'tailscale',
    });

    expect(catalog.shellAccounts).toEqual(['sprite']);
    expect(catalog.networks).toEqual([
      expect.objectContaining({
        id: 'tailscale',
        installer: 'drivers/networks/tailscale/guest/tailscale-install.js',
      }),
    ]);
  });

  it('should list no network installer when the selected network installs nothing', () => {
    const catalog = componentCatalog({
      provider: 'sprite',
      agent: 't3',
      network: 'none',
    });

    expect(catalog.networks).toEqual([]);
    expect(JSON.stringify(catalog)).not.toMatch(/tailscale/iu);
  });

  it('should refuse an installer the network deploys for a non-root account', async () => {
    const { componentCatalog: catalogOf } = await catalogsWith([
      {
        module: 'drivers/networks/tailscale/guest/tailscale-install.js',
        account: 'agent',
      },
    ]);

    expect(() =>
      catalogOf({ provider: 'sprite', agent: 't3', network: 'tailscale' }),
    ).toThrow(
      'Installer drivers/networks/tailscale/guest/tailscale-install.js of tailscale is not a root module the network deploys',
    );
  });

  it.each([
    'drivers/networks/tailscale/guest/tailscale-launcher.js',
    'drivers/networks/other/guest/tailscale-install.js',
  ])(
    'should refuse %s, which a root update would execute as an installer',
    async (installer) => {
      vi.resetModules();
      vi.doMock('#core/guest-leaves', async (importOriginal) => {
        const original =
          await importOriginal<typeof import('#core/guest-leaves')>();
        const network: NetworkGuestLeaf = {
          ...tailscaleGuestLeaf,
          releaseFeed: {
            kind: 'release',
            feed: 'https://releases.example/feed',
            installer,
          },
          guest: [{ module: installer, account: 'root' }],
        };

        return {
          GUEST_LEAVES: {
            ...original.GUEST_LEAVES,
            networks: { tailscale: network },
          },
        };
      });
      const { componentCatalog: catalogOf } =
        await import('#core/guest-catalogs');

      expect(() =>
        catalogOf({ provider: 'sprite', agent: 't3', network: 'tailscale' }),
      ).toThrow(
        `Installer ${installer} of tailscale is not a root module the network deploys`,
      );
    },
  );

  it('should refuse an installer the network does not deploy', async () => {
    const { componentCatalog: catalogOf } = await catalogsWith([
      {
        module: 'drivers/networks/tailscale/guest/other-install.js',
        account: 'root',
      },
    ]);

    expect(() =>
      catalogOf({ provider: 'sprite', agent: 't3', network: 'tailscale' }),
    ).toThrow(
      'Installer drivers/networks/tailscale/guest/tailscale-install.js of tailscale is not a root module the network deploys',
    );
  });
});

describe('fn:harnessCatalogEntry', () => {
  const tools = [npmTool('fixture', '@example/fixture')];
  const acpAdapter: AcpAdapterSpec = {
    tool: npmTool('fixture-acp', '@example/fixture-acp'),
    launch: { program: 'fixture-acp', arguments: [] },
  };

  it('should carry the adapter a harness declares as a component of its own', () => {
    expect(
      harnessCatalogEntry({
        id: 'fixture',
        tools,
        spawnEnvironment: { FIXTURE: '1' },
        acpAdapter,
      }),
    ).toEqual({
      id: 'fixture',
      component: 'fixture',
      package: '@example/fixture',
      probe: ['fixture', '--version'],
      environment: { FIXTURE: '1' },
      adapter: {
        component: 'fixture-acp',
        package: '@example/fixture-acp',
        probe: ['fixture-acp', '--version'],
      },
    });
  });

  it('should carry no adapter for a harness that declares none', () => {
    expect(
      harnessCatalogEntry({ id: 'fixture', tools, spawnEnvironment: {} }),
    ).not.toHaveProperty('adapter');
  });

  it('should refuse an adapter that is not installable from npm', () => {
    expect(() =>
      harnessCatalogEntry({
        id: 'fixture',
        tools,
        spawnEnvironment: {},
        acpAdapter: {
          ...acpAdapter,
          tool: {
            ...acpAdapter.tool,
            sources: [{ kind: 'brew', formula: 'fixture-acp' }],
          },
        },
      }),
    ).toThrow('Component fixture-acp of fixture is not installable from npm');
  });
});

describe('fn:componentCatalog provider entry', () => {
  it('should record the provider capability axes the governor decides by, with the Sprite awake adapter', () => {
    const catalog = componentCatalog({
      provider: 'sprite',
      agent: 't3',
      network: 'tailscale',
    });

    expect(catalog.provider).toEqual({
      id: 'sprite',
      keepAwakeMode: 'native-deadline',
      awakeAdapter: 'drivers/providers/sprite/guest/sprite-awake.js',
      wakeMode: 'url-traffic',
      supportsCliWakeSleep: false,
      maxAwakeDeadlineMinutes: 60,
      serviceBackend: 'provider',
      transportNetworks: [],
    });
  });

  it('should record an -awake module the provider deploys for the agent account', async () => {
    const { componentCatalog: catalogOf } = await catalogsWithAdapter({
      module: 'drivers/providers/sprite/guest/sprite-awake.js',
      account: 'agent',
    });

    expect(
      catalogOf({ provider: 'sprite', agent: 't3', network: 'tailscale' })
        .provider,
    ).toEqual(
      expect.objectContaining({
        awakeAdapter: 'drivers/providers/sprite/guest/sprite-awake.js',
      }),
    );
  });

  it('should record a governed provider adapter root loads', async () => {
    const { componentCatalog: catalogOf } = await catalogsWithAdapter(
      {
        module: 'drivers/providers/sprite/guest/sprite-awake.js',
        account: 'root',
      },
      'governed',
    );

    expect(
      catalogOf({ provider: 'sprite', agent: 't3', network: 'tailscale' })
        .provider,
    ).toEqual(
      expect.objectContaining({
        keepAwakeMode: 'governed',
        awakeAdapter: 'drivers/providers/sprite/guest/sprite-awake.js',
      }),
    );
  });

  it('should refuse a governed provider adapter declared for the agent account', async () => {
    const { componentCatalog: catalogOf } = await catalogsWithAdapter(
      {
        module: 'drivers/providers/sprite/guest/sprite-awake.js',
        account: 'agent',
      },
      'governed',
    );

    expect(() =>
      catalogOf({ provider: 'sprite', agent: 't3', network: 'tailscale' }),
    ).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('for its keep-awake mode'),
      }),
    );
  });

  it.each([
    [
      'in another provider folder',
      'drivers/providers/other/guest/sprite-awake.js',
      'agent',
    ],
    [
      'without the -awake suffix',
      'drivers/providers/sprite/guest/sprite-hold.js',
      'agent',
    ],
    [
      'nested below the guest folder',
      'drivers/providers/sprite/guest/x/sprite-awake.js',
      'agent',
    ],
    [
      'nested below a provider folder named like the provider',
      'drivers/providers/sprite/guest/sprite/guest/sprite-awake.js',
      'agent',
    ],
    [
      'with a parent segment',
      'drivers/providers/sprite/guest/../guest/sprite-awake.js',
      'agent',
    ],
    [
      'that hooks of the agent account cannot run',
      'drivers/providers/sprite/guest/sprite-awake.js',
      'root',
    ],
  ] as const)(
    'should refuse an awake adapter %s',
    async (_, module, account) => {
      const { componentCatalog: catalogOf } = await catalogsWithAdapter({
        module,
        account,
      });

      expect(() =>
        catalogOf({ provider: 'sprite', agent: 't3', network: 'tailscale' }),
      ).toThrow(
        expect.objectContaining({ message: expect.stringContaining(module) }),
      );
    },
  );
});
