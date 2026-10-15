import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { componentCatalog } from '#core/guest-catalogs';
import {
  isProviderComponent,
  readComponentCatalog,
  readShellAccounts,
} from '#guest/component-catalog';
import { isManagedHome } from '#guest/native-files';

const { root } = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir: temporaryRoot } = await import('node:os');
  const { join: joinPath } = await import('node:path');

  return {
    root: await mkdtemp(joinPath(temporaryRoot(), 'open-agent-catalog-')),
  };
});

vi.mock('#guest/guest-root', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#guest/guest-root')>()),
  GUEST_ROOT: root,
  GUEST_NODE: `${root}/node/bin/node`,
  AGENT_HOME: '/home/agent',
}));

const catalogPath = join(root, 'components.json');

/**
 * records a component catalog the way the host does
 * @param catalog decoded catalog contents
 */
async function recordCatalog(catalog: unknown): Promise<void> {
  await writeFile(catalogPath, JSON.stringify(catalog));
}

afterEach(async () => {
  await rm(catalogPath, { force: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('fn:readShellAccounts', () => {
  it('should read the provider accounts without validating the rest of the catalog', async () => {
    await recordCatalog({
      shellAccounts: ['sprite'],
      agent: 'not a component',
    });

    await expect(readShellAccounts()).resolves.toEqual(['sprite']);
    await expect(readComponentCatalog()).rejects.toThrow(
      'Managed component catalog is malformed',
    );
  });

  it('should refuse account names that are not plain login names', async () => {
    await recordCatalog({ shellAccounts: ['../root'] });

    await expect(readShellAccounts()).rejects.toThrow(
      'Managed component catalog is malformed',
    );
  });

  it('should name the repair when the host has not recorded the catalog', async () => {
    await expect(readShellAccounts()).rejects.toThrow(
      /components\.json is missing; run `open-agent setup <name> --section agent`/,
    );
  });
});

describe('fn:readComponentCatalog', () => {
  const recorded = componentCatalog({
    provider: 'sprite',
    agent: 't3',
    network: 'tailscale',
  });

  it('should accept the catalog the host records', async () => {
    await recordCatalog(recorded);

    await expect(readComponentCatalog()).resolves.toEqual(recorded);
  });

  it.each([
    'install-tools.js',
    'tailscale-install.js',
    'guest/install-tools.js',
    'drivers/networks/tailscale/guest/../../../../guest/install-tools.js',
    'drivers/harnesses/claude/guest/claude-init-probe.js',
    'drivers/networks/tailscale/tailscale-install.js',
    'drivers/networks/tailscale/guest/tailscale-launcher.js',
    'drivers/networks/tailscale/guest/tailscale-install-helper.js',
    'drivers/networks/other/guest/other-install.js',
  ])('should refuse %s as a network installer', async (installer) => {
    await recordCatalog({
      ...recorded,
      networks: recorded.networks.map((network) => ({
        ...network,
        installer,
      })),
    });

    await expect(readComponentCatalog()).rejects.toThrow(
      'Managed component catalog is malformed',
    );
  });
});

describe('fn:isProviderComponent', () => {
  const provider = {
    id: 'fixture',
    keepAwakeMode: 'governed',
    wakeMode: 'cli-restore',
    supportsCliWakeSleep: true,
    maxAwakeDeadlineMinutes: null,
    serviceBackend: 'runit',
    transportNetworks: [],
    awakeAdapter: 'drivers/providers/fixture/guest/fixture-awake.js',
  };

  it('should accept a provider whose adapter is an -awake module of its own guest folder', () => {
    expect(isProviderComponent(provider)).toBe(true);
  });

  it.each([
    ['an unknown keep-awake mode', { ...provider, keepAwakeMode: 'sometimes' }],
    ['an unknown wake mode', { ...provider, wakeMode: 'ping' }],
    ['a textual opt-in', { ...provider, supportsCliWakeSleep: 'yes' }],
    [
      'no stated awake limit',
      { ...provider, maxAwakeDeadlineMinutes: undefined },
    ],
    ['a zero awake limit', { ...provider, maxAwakeDeadlineMinutes: 0 }],
    ['a fractional awake limit', { ...provider, maxAwakeDeadlineMinutes: 1.5 }],
    ['a textual awake limit', { ...provider, maxAwakeDeadlineMinutes: '60' }],
    ['no stated service backend', { ...provider, serviceBackend: undefined }],
    ['an unknown service backend', { ...provider, serviceBackend: 'cron' }],
    [
      'no stated transport networks',
      { ...provider, transportNetworks: undefined },
    ],
    [
      'a transport network without a prefix length',
      { ...provider, transportNetworks: ['172.16.0.0'] },
    ],
    [
      'a transport network that reads as an option',
      { ...provider, transportNetworks: ['-6/16'] },
    ],
    [
      'a transport network with an oversized IPv4 prefix',
      { ...provider, transportNetworks: ['172.16.0.0/33'] },
    ],
    ['an adapter of another provider', { ...provider, id: 'other' }],
    [
      'an adapter without the -awake suffix',
      {
        ...provider,
        awakeAdapter: 'drivers/providers/fixture/guest/fixture.js',
      },
    ],
    [
      'an adapter climbing out of its folder',
      {
        ...provider,
        awakeAdapter:
          'drivers/providers/fixture/guest/../../other/guest/x-awake.js',
      },
    ],
  ])('should refuse %s', (_, value) => {
    expect(isProviderComponent(value)).toBe(false);
  });
});

describe('fn:isManagedHome', () => {
  it('should manage the agent home without reading the catalog', async () => {
    await expect(isManagedHome('/home/agent')).resolves.toBe(true);
  });

  it('should manage only the homes of recorded provider accounts', async () => {
    await recordCatalog({ shellAccounts: ['sprite'] });

    await expect(isManagedHome('/home/sprite')).resolves.toBe(true);
    await expect(isManagedHome('/home/other')).resolves.toBe(false);
  });
});
