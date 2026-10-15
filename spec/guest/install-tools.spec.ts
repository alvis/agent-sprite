import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComponentCatalog } from '#drivers/component-types';
import type { HarnessEntry } from '#guest/harness-catalog';

const { root, state } = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir: temporaryRoot } = await import('node:os');
  const { join: joinPath } = await import('node:path');

  return {
    root: await mkdtemp(joinPath(temporaryRoot(), 'open-agent-install-tools-')),
    state: {
      /** npm packages that are on disk */
      present: new Set<string>(),
      /** npm packages whose install does nothing */
      broken: new Set<string>(),
      /** components handed to the npm installer, in order */
      ensured: [] as string[],
      /** Homebrew formulae and the Rust toolchain handed to their installers, in order */
      poured: [] as string[],
      /** every program the installer ran as the agent */
      ran: [] as string[][],
      harnesses: [] as unknown[],
      /** the provider the recorded component catalog names, if any */
      provider: undefined as ComponentCatalog['provider'],
    },
  };
});

const CATALOG: ComponentCatalog = {
  shellAccounts: [],
  agent: {
    id: 'agent',
    component: 'agent',
    package: '@example/agent',
    probe: ['agent', '--version'],
    harnessNames: {},
    httpPort: 4000,
  },
  runtime: {
    component: 'runtime',
    package: '@example/runtime',
    probe: ['runtime', '--version'],
  },
  packages: [],
  networks: [],
};
const HARNESS = {
  id: 'fixture',
  component: 'fixture',
  package: '@example/fixture',
  probe: ['fixture', '--version'],
  environment: {},
  adapter: {
    component: 'fixture-acp',
    package: '@example/fixture-acp',
    probe: ['fixture-acp', '--version'],
  },
} satisfies HarnessEntry;

vi.mock('#guest/guest-root', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#guest/guest-root')>()),
  GUEST_ROOT: root,
  GUEST_KERNEL: `${root}/guest`,
}));

vi.mock('#guest/install-tools/context', async () => {
  const { openSync } = await import('node:fs');

  return {
    home: '/home/agent',
    link: async () => undefined,
    log: openSync(`${root}/install-tools.log`, 'a'),
    run: async (_executable: string, args: string[]) => {
      state.ran.push(args);

      return '';
    },
    runAsHomebrew: async () => '',
    temporary: `${root}/scratch`,
  };
});

vi.mock('#guest/install-tools/tools', () => ({ tools: {} }));

vi.mock('#guest/install-tools/formula', () => ({
  formulaComponent: (
    _tools: unknown,
    _homebrew: unknown,
    tool: { formula: string },
  ) => settled(tool.formula),
}));

vi.mock('#guest/install-tools/rust', () => ({
  rustComponent: () => settled('rust'),
}));

// the log descriptor is shared by every run of the installer in this file
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  closeSync: () => undefined,
}));

vi.mock('#guest/install-tools/networks', () => ({
  installNetworks: async () => undefined,
}));

vi.mock('#guest/install-tools/npm', () => ({
  npmComponent: (
    _tools: unknown,
    entry: { component: string; package: string },
  ) => {
    state.ensured.push(entry.component);

    return {
      component: entry.component,
      resolve: async () => ({ version: '2.0.0' }),
      installed: async () =>
        state.present.has(entry.package) ? '2.0.0' : undefined,
      install: async () => {
        if (!state.broken.has(entry.package)) {
          state.present.add(entry.package);
        }
      },
    };
  },
}));

vi.mock('#guest/component-catalog', () => ({
  readComponentCatalog: async () => ({ ...CATALOG, provider: state.provider }),
}));

vi.mock('#guest/harness-catalog', () => ({
  readHarnessCatalog: async () => state.harnesses,
}));

/**
 * builds a component that is always current
 * @param component its key in the outcomes
 * @returns how the ledger finds it current
 */
function settled(component: string): {
  component: string;
  resolve: () => Promise<{ version: string }>;
  installed: () => Promise<string>;
  install: () => Promise<void>;
} {
  state.poured.push(component);

  return {
    component,
    resolve: async () => ({ version: '1.0.0' }),
    installed: async () => '1.0.0',
    install: async () => undefined,
  };
}

/** runs the installer, which starts on import */
async function installTools(): Promise<void> {
  vi.resetModules();
  await import('#guest/install-tools');
}

/**
 * reads the outcomes the installer left
 * @returns the decoded outcomes file
 */
async function outcomes(): Promise<Record<string, { status: string }>> {
  return JSON.parse(
    await readFile(join(root, 'install-outcomes.json'), 'utf8'),
  ) as Record<string, { status: string }>;
}

beforeEach(async () => {
  state.present = new Set(['@example/agent', '@example/runtime']);
  state.broken = new Set();
  state.ensured = [];
  state.poured = [];
  state.ran = [];
  state.harnesses = [HARNESS];
  state.provider = undefined;
  await rm(join(root, 'install-outcomes.json'), { force: true });
  await writeFile(join(root, 'install-tools.log'), '');
});

afterAll(() => {
  vi.resetModules();
});

describe('script:install-tools', () => {
  it('should install the bootstrap, compiler and network diagnostic packages and no other build tooling', async () => {
    await installTools();

    const packages = state.ran
      .find(([command]) => command === 'install')
      ?.filter((arg) => !arg.startsWith('-') && arg !== 'install');
    expect(packages).toEqual([
      'git',
      'curl',
      'ca-certificates',
      'procps',
      'file',
      'unzip',
      'gcc',
      'libc6-dev',
      'iputils-ping',
      'telnet',
      'dnsutils',
      'netcat-openbsd',
      'traceroute',
      'iproute2',
      'wget',
      'cron',
    ]);
    expect(
      packages?.filter((name) =>
        /^(?:build-essential|g\+\+|make|gettext|cmake|autoconf)$/.test(name),
      ),
    ).toEqual([]);
  });

  it('should pour every Homebrew formula in table order and then the Rust toolchain', async () => {
    await installTools();

    expect(state.poured).toEqual([
      'git',
      'jj',
      'gh',
      'node',
      'pnpm',
      'python3',
      'uv',
      'rustup',
      'httpie',
      'rust',
    ]);
  });

  it('should probe the network diagnostics as the agent account', async () => {
    await installTools();

    const probes = state.ran
      .filter(([flag]) => flag === '-u')
      .map((args) =>
        args
          .slice(args.findIndex((arg) => arg.startsWith('PATH=')) + 1)
          .join(' '),
      );
    expect(probes).toEqual(
      expect.arrayContaining([
        'ping -V',
        'test -x /usr/bin/telnet',
        'dig -v',
        'test -x /usr/bin/nc',
        'traceroute --version',
        'ip -V',
        'wget --version',
      ]),
    );
  });

  it('should install no cron where the guest supervisor runs the schedule', async () => {
    state.provider = {
      id: 'fixture',
      keepAwakeMode: 'governed',
      wakeMode: 'url-traffic',
      supportsCliWakeSleep: false,
      maxAwakeDeadlineMinutes: null,
      servicesMode: 'supervised',
      transportNetworks: [],
    };

    await installTools();

    const packages = state.ran
      .find(([command]) => command === 'install')
      ?.filter((arg) => !arg.startsWith('-') && arg !== 'install');
    expect(packages).not.toContain('cron');
    expect(packages).toContain('gcc');
  });

  it('should install the adapter a selected harness declares beside the harness and verify it', async () => {
    await installTools();

    expect(state.ensured).toEqual([
      'fixture',
      'fixture-acp',
      'agent',
      'runtime',
    ]);
    expect(await outcomes()).toMatchObject({
      'fixture': { status: 'installed' },
      'fixture-acp': { status: 'installed' },
    });
    expect(
      state.ran.some(
        (args) =>
          args.slice(-2).join(' ') === 'fixture-acp --version' &&
          args[0] === '-u',
      ),
    ).toBe(true);
  });

  it('should skip the adapter on a repeated run', async () => {
    state.present.add('@example/fixture').add('@example/fixture-acp');

    await installTools();

    expect(await outcomes()).toMatchObject({
      'fixture': { status: 'skipped' },
      'fixture-acp': { status: 'skipped' },
    });
  });

  it('should fail the run and name the adapter when it does not install', async () => {
    state.broken.add('@example/fixture-acp');

    await expect(installTools()).rejects.toThrow(
      'Components failed: fixture-acp',
    );

    expect(await outcomes()).toMatchObject({
      'fixture': { status: 'installed' },
      'fixture-acp': { status: 'failed' },
    });
  });

  it('should install nothing extra for a harness that declares no adapter', async () => {
    state.harnesses = [{ ...HARNESS, adapter: undefined }];

    await installTools();

    expect(state.ensured).toEqual(['fixture', 'agent', 'runtime']);
  });
});
