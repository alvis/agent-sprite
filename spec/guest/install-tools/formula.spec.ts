import { describe, expect, it, vi } from 'vitest';

import { HOMEBREW, HOMEBREW_TOOLS } from '#guest/homebrew';
import { formulaComponent } from '#guest/install-tools/formula';
import { ComponentLedger } from '#guest/install-tools/ledger';

import {
  ranPrograms,
  runnerFor,
  toolsWith,
} from '../../fixtures/install-tools.js';

import type { HomebrewTool } from '#guest/homebrew';
import type { Homebrew } from '#guest/install-tools/homebrew';

const PROBE = '/usr/local/bin/git --version';
const KEG = `${HOMEBREW.prefix}/opt`;

/**
 * finds a tool in the table every workstation installs
 * @param formula the formula's name in the table
 * @returns the table's entry
 * @throws {Error} when the table has no such formula
 */
function toolOf(formula: string): HomebrewTool {
  const tool = HOMEBREW_TOOLS.find((entry) => entry.formula === formula);
  if (!tool) {
    throw new Error(`No ${formula} in the table`);
  }

  return tool;
}

const GIT = toolOf('git');

/** how the fake Homebrew answers */
interface Formulae {
  /** Homebrew's stable version of the tool under test */
  stable?: string;
  /** Git's recursive runtime dependencies */
  dependencies?: string[];
  /** bottle platforms per formula; a formula not listed has a bottle for this platform */
  bottles?: Record<string, string[]>;
  /** the formula an alias resolves to, by the name the tool asks for */
  aliases?: Record<string, string>;
  /** the commands a keg directory holds, by the directory */
  entries?: Record<string, string[]>;
  /** whether Git's keg is installed */
  kegged?: boolean;
  /** whether `/usr/local/bin/git` resolves into the prefix, in turn */
  linked?: boolean[];
  /** the installed formulae brew reports outdated, in turn */
  outdated?: string[][];
}

/**
 * builds a Homebrew that answers from a table instead of running brew
 * @param formulae what the fake Homebrew reports
 * @returns the fake and its brew runner
 */
function fakeHomebrew(formulae: Formulae = {}): Homebrew & {
  run: ReturnType<typeof vi.fn<Homebrew['run']>>;
  ready: ReturnType<typeof vi.fn<Homebrew['ready']>>;
} {
  const {
    stable = '2.56.0',
    dependencies = ['curl', 'openssl@4'],
    bottles = {},
    aliases = {},
    entries = {},
    kegged = false,
    linked = [true],
    outdated = [[]],
  } = formulae;
  let owned = 0;
  let reported = 0;

  return {
    layout: { ...HOMEBREW },
    bottle: 'x86_64_linux',
    ready: vi.fn<Homebrew['ready']>(async () => undefined),
    run: vi.fn<Homebrew['run']>(async ([command, ...args]) => {
      if (command === 'deps') {
        return `${dependencies.join('\n')}\n`;
      }
      if (command === 'outdated') {
        const names = outdated[Math.min(reported++, outdated.length - 1)] ?? [];

        return JSON.stringify({
          formulae: names.map((name) => ({ name })),
          casks: [],
        });
      }
      if (command === 'info') {
        return JSON.stringify({
          formulae: args.slice(1).map((asked) => {
            const name = aliases[asked] ?? asked;

            return {
              name,
              versions: {
                stable: HOMEBREW_TOOLS.some((tool) => tool.formula === asked)
                  ? stable
                  : '1.0.0',
              },
              bottle: {
                stable: {
                  files: Object.fromEntries(
                    (bottles[name] ?? ['x86_64_linux', 'arm64_linux']).map(
                      (tag) => [tag, { url: `https://ghcr.io/${name}` }],
                    ),
                  ),
                },
              },
            };
          }),
          casks: [],
        });
      }

      return '';
    }),
    entries: vi.fn<Homebrew['entries']>(
      async (directory) => entries[directory] ?? [],
    ),
    has: vi.fn<Homebrew['has']>(async () => kegged),
    owns: vi.fn<Homebrew['owns']>(
      async () => linked[Math.min(owned++, linked.length - 1)] ?? false,
    ),
  };
}

/**
 * lists the brew commands a fake Homebrew ran
 * @param homebrew the fake
 * @returns each command's arguments
 */
function brewed(homebrew: ReturnType<typeof fakeHomebrew>): string[][] {
  return homebrew.run.mock.calls.map(([args]) => [...args]);
}

describe('fn:formulaComponent', () => {
  it('should skip Git without installing when it reports the stable Homebrew version', async () => {
    const run = runnerFor({ [PROBE]: 'git version 2.56.0\n' });
    const tools = toolsWith({ run });
    const homebrew = fakeHomebrew();
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(formulaComponent(tools, homebrew, GIT));

    expect(homebrew.ready).toHaveBeenCalledOnce();
    expect(brewed(homebrew)).toEqual([
      ['info', '--json=v2', 'git'],
      ['deps', 'git'],
      ['outdated', '--json=v2'],
    ]);
    expect(ranPrograms(run)).toEqual([['/usr/local/bin/git', '--version']]);
    expect(tools.link).not.toHaveBeenCalled();
    expect(ledger.outcomes()).toEqual({
      git: { status: 'skipped', version: '2.56.0' },
    });
  });

  it('should probe Git as the agent account, not as root', async () => {
    const run = runnerFor({ [PROBE]: 'git version 2.56.0\n' });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(
      formulaComponent(toolsWith({ run }), fakeHomebrew(), GIT),
    );

    expect(run.mock.calls[0]?.[0]).toBe('/usr/sbin/runuser');
    expect(run.mock.calls[0]?.[1].slice(0, 3)).toEqual(['-u', 'agent', '--']);
  });

  it('should upgrade the installed keg in place and relink it when Git is older', async () => {
    const run = runnerFor({
      [PROBE]: ['git version 2.55.0\n', 'git version 2.56.0\n'],
    });
    const tools = toolsWith({ run });
    const homebrew = fakeHomebrew({ kegged: true });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(formulaComponent(tools, homebrew, GIT));

    expect(brewed(homebrew)).toEqual([
      ['info', '--json=v2', 'git'],
      ['deps', 'git'],
      ['outdated', '--json=v2'],
      ['info', '--json=v2', 'git', 'curl', 'openssl@4'],
      ['outdated', '--json=v2'],
      ['upgrade', 'git'],
      ['outdated', '--json=v2'],
    ]);
    expect(vi.mocked(tools.link).mock.calls).toEqual([
      [`${KEG}/git/bin/git`, '/usr/local/bin/git'],
    ]);
    expect(ledger.outcomes()).toEqual({
      git: { status: 'installed', version: '2.56.0' },
    });
  });

  it('should upgrade the outdated formulae Git depends on while its version is current', async () => {
    const notes: string[] = [];
    const run = runnerFor({ [PROBE]: 'git version 2.56.0\n' });
    const tools = toolsWith({ run });
    const homebrew = fakeHomebrew({
      kegged: true,
      outdated: [['openssl@4', 'python'], ['openssl@4', 'python'], ['python']],
    });
    const ledger = new ComponentLedger((line) => notes.push(line));

    await ledger.ensure(formulaComponent(tools, homebrew, GIT));

    expect(notes).toContain(
      'Component git is 2.56.0 with openssl@4 outdated; installing 2.56.0',
    );
    expect(brewed(homebrew)).toContainEqual(['upgrade', 'openssl@4']);
    expect(vi.mocked(tools.link).mock.calls).toEqual([
      [`${KEG}/git/bin/git`, '/usr/local/bin/git'],
    ]);
    expect(ledger.outcomes()).toEqual({
      git: { status: 'installed', version: '2.56.0' },
    });
  });

  it('should skip Git when only formulae it does not depend on are outdated', async () => {
    const run = runnerFor({ [PROBE]: 'git version 2.56.0\n' });
    const homebrew = fakeHomebrew({ outdated: [['python']] });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(formulaComponent(toolsWith({ run }), homebrew, GIT));

    expect(ledger.outcomes()).toEqual({
      git: { status: 'skipped', version: '2.56.0' },
    });
  });

  it('should install Git from its bottle when no keg exists', async () => {
    const run = runnerFor({ [PROBE]: 'git version 2.56.0\n' });
    const tools = toolsWith({ run });
    const homebrew = fakeHomebrew({ linked: [false, true] });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(formulaComponent(tools, homebrew, GIT));

    expect(brewed(homebrew)).toContainEqual(['install', 'git']);
    expect(brewed(homebrew)).not.toContainEqual(
      expect.arrayContaining(['upgrade']),
    );
    expect(vi.mocked(tools.link).mock.calls).toEqual([
      [`${KEG}/git/bin/git`, '/usr/local/bin/git'],
    ]);
    expect(ledger.outcomes()).toEqual({
      git: { status: 'installed', version: '2.56.0' },
    });
  });

  it('should treat a Git linked from outside the prefix as absent', async () => {
    const run = runnerFor({ [PROBE]: 'git version 2.56.0\n' });
    const homebrew = fakeHomebrew({ linked: [false, true] });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(formulaComponent(toolsWith({ run }), homebrew, GIT));

    expect(ranPrograms(run)).toEqual([['/usr/local/bin/git', '--version']]);
    expect(brewed(homebrew)).toContainEqual(['install', 'git']);
    expect(ledger.outcomes().git?.status).toBe('installed');
  });

  it('should accept a dependency whose only bottle serves every platform', async () => {
    const run = runnerFor({
      [PROBE]: ['', 'git version 2.56.0\n'],
    });
    const homebrew = fakeHomebrew({
      dependencies: ['ca-certificates'],
      bottles: { 'ca-certificates': ['all'] },
    });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(formulaComponent(toolsWith({ run }), homebrew, GIT));

    expect(brewed(homebrew)).toContainEqual(['install', 'git']);
    expect(ledger.outcomes().git?.status).toBe('installed');
  });

  it('should refuse and fail Git without installing when a dependency has no bottle for this platform', async () => {
    const notes: string[] = [];
    const run = runnerFor({ [PROBE]: 'git version 2.55.0\n' });
    const tools = toolsWith({ run });
    const homebrew = fakeHomebrew({
      kegged: true,
      bottles: { 'openssl@4': ['arm64_linux'] },
    });
    const ledger = new ComponentLedger((line) => notes.push(line));

    await ledger.ensure(formulaComponent(tools, homebrew, GIT));

    expect(brewed(homebrew).map(([command]) => command)).toEqual([
      'info',
      'deps',
      'outdated',
      'info',
    ]);
    expect(tools.link).not.toHaveBeenCalled();
    expect(notes).toContain(
      'Component git failed: No x86_64_linux bottle for openssl@4; refusing to build from source',
    );
    expect(ledger.outcomes()).toEqual({
      git: { status: 'failed', error: 'install failed' },
    });
  });

  it('should refuse when Git itself has no bottle for this platform', async () => {
    const run = runnerFor({ [PROBE]: '' });
    const homebrew = fakeHomebrew({ bottles: { git: [] } });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(formulaComponent(toolsWith({ run }), homebrew, GIT));

    expect(brewed(homebrew).map(([command]) => command)).not.toContain(
      'install',
    );
    expect(ledger.outcomes().git?.status).toBe('failed');
  });

  it('should fail to resolve Git when Homebrew lists no stable version', async () => {
    const run = runnerFor({});
    const homebrew = fakeHomebrew({ stable: 'HEAD' });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(formulaComponent(toolsWith({ run }), homebrew, GIT));

    expect(ranPrograms(run)).toEqual([]);
    expect(ledger.outcomes()).toEqual({
      git: {
        status: 'failed',
        error: 'latest version could not be resolved',
      },
    });
  });

  it('should fail to resolve Git when Homebrew cannot be made ready', async () => {
    const homebrew = fakeHomebrew();
    homebrew.ready.mockRejectedValueOnce(new Error('installer failed'));
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(formulaComponent(toolsWith(), homebrew, GIT));

    expect(homebrew.run).not.toHaveBeenCalled();
    expect(ledger.outcomes()).toEqual({
      git: {
        status: 'failed',
        error: 'latest version could not be resolved',
      },
    });
  });

  it.each([
    ['jj', 'jj 0.35.0\n'],
    [
      'gh',
      'gh version 0.35.0 (2026-10-01)\nhttps://github.com/cli/cli/releases/tag/v0.35.0\n',
    ],
  ] as const)(
    'should skip %s through brew without reading a release feed when it reports the stable version',
    async (tool, output) => {
      const run = runnerFor({ [`/usr/local/bin/${tool} --version`]: output });
      const tools = toolsWith({ run });
      const homebrew = fakeHomebrew({ stable: '0.35.0', dependencies: [] });
      const ledger = new ComponentLedger(() => undefined);

      await ledger.ensure(formulaComponent(tools, homebrew, toolOf(tool)));

      expect(brewed(homebrew)).toEqual([
        ['info', '--json=v2', tool],
        ['deps', tool],
        ['outdated', '--json=v2'],
      ]);
      expect(tools.downloadText).not.toHaveBeenCalled();
      expect(ledger.outcomes()).toEqual({
        [tool]: { status: 'skipped', version: '0.35.0' },
      });
    },
  );

  it.each(['jj', 'gh'] as const)(
    'should pour %s from its bottle and link it from its keg',
    async (tool) => {
      const run = runnerFor({
        [`/usr/local/bin/${tool} --version`]: `${tool} 0.35.0\n`,
      });
      const tools = toolsWith({ run });
      const homebrew = fakeHomebrew({
        stable: '0.35.0',
        dependencies: [],
        linked: [false, true],
      });
      const ledger = new ComponentLedger(() => undefined);

      await ledger.ensure(formulaComponent(tools, homebrew, toolOf(tool)));

      expect(brewed(homebrew)).toContainEqual(['install', tool]);
      expect(vi.mocked(tools.link).mock.calls).toEqual([
        [`${KEG}/${tool}/bin/${tool}`, `/usr/local/bin/${tool}`],
      ]);
      expect(ledger.outcomes()).toEqual({
        [tool]: { status: 'installed', version: '0.35.0' },
      });
    },
  );

  it('should link every command a multi-command formula provides from its keg', async () => {
    const run = runnerFor({ '/usr/local/bin/node --version': 'v25.1.0\n' });
    const tools = toolsWith({ run });
    const homebrew = fakeHomebrew({
      stable: '25.1.0',
      dependencies: [],
      linked: [false, true],
    });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(formulaComponent(tools, homebrew, toolOf('node')));

    expect(vi.mocked(tools.link).mock.calls).toEqual([
      [`${KEG}/node/bin/node`, '/usr/local/bin/node'],
      [`${KEG}/node/bin/npm`, '/usr/local/bin/npm'],
      [`${KEG}/node/bin/npx`, '/usr/local/bin/npx'],
    ]);
    expect(ledger.outcomes()).toEqual({
      node: { status: 'installed', version: '25.1.0' },
    });
  });

  it('should link Python from both of its directories under the alias the ledger keys it by', async () => {
    const run = runnerFor({
      '/usr/local/bin/python3 --version': 'Python 3.15.1\n',
    });
    const tools = toolsWith({ run });
    const homebrew = fakeHomebrew({
      stable: '3.15.1',
      dependencies: [],
      aliases: { python3: 'python@3.15' },
      linked: [false, true],
    });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(formulaComponent(tools, homebrew, toolOf('python3')));

    expect(brewed(homebrew)).toEqual([
      ['info', '--json=v2', 'python3'],
      ['deps', 'python@3.15'],
      ['info', '--json=v2', 'python@3.15'],
      ['install', 'python@3.15'],
      ['outdated', '--json=v2'],
    ]);
    expect(vi.mocked(tools.link).mock.calls).toEqual([
      [`${KEG}/python3/bin/python3`, '/usr/local/bin/python3'],
      [`${KEG}/python3/bin/pip3`, '/usr/local/bin/pip3'],
      [`${KEG}/python3/libexec/bin/python`, '/usr/local/bin/python'],
      [`${KEG}/python3/libexec/bin/pip`, '/usr/local/bin/pip'],
    ]);
    expect(ledger.outcomes()).toEqual({
      python3: { status: 'installed', version: '3.15.1' },
    });
  });

  it('should link every proxy a keg-only formula holds and probe it without a toolchain download', async () => {
    const run = runnerFor({
      '/usr/bin/env RUSTUP_AUTO_INSTALL=0 /usr/local/bin/rustup --version':
        'rustup 1.29.0 (2026-01-01)\n',
    });
    const tools = toolsWith({ run });
    const homebrew = fakeHomebrew({
      stable: '1.29.0',
      dependencies: [],
      entries: { [`${KEG}/rustup/bin`]: ['rustup', 'cargo', 'rustc'] },
      linked: [false, true],
    });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(formulaComponent(tools, homebrew, toolOf('rustup')));

    expect(vi.mocked(tools.link).mock.calls).toEqual([
      [`${KEG}/rustup/bin/rustup`, '/usr/local/bin/rustup'],
      [`${KEG}/rustup/bin/cargo`, '/usr/local/bin/cargo'],
      [`${KEG}/rustup/bin/rustc`, '/usr/local/bin/rustc'],
    ]);
    expect(ledger.outcomes()).toEqual({
      rustup: { status: 'installed', version: '1.29.0' },
    });
  });

  it('should fail a tool whose keg holds none of the commands it links', async () => {
    const run = runnerFor({ '/usr/local/bin/rustup --version': '' });
    const tools = toolsWith({ run });
    const homebrew = fakeHomebrew({
      stable: '1.29.0',
      dependencies: [],
      linked: [false],
    });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(formulaComponent(tools, homebrew, toolOf('rustup')));

    expect(tools.link).not.toHaveBeenCalled();
    expect(ledger.outcomes().rustup?.status).toBe('failed');
  });

  it('should fail a tool whose keg lacks a command it names', async () => {
    const run = runnerFor({ '/usr/local/bin/node --version': '' });
    const tools = toolsWith({ run });
    const homebrew = fakeHomebrew({
      stable: '25.1.0',
      dependencies: [],
      linked: [false, true, false],
    });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(formulaComponent(tools, homebrew, toolOf('node')));

    expect(vi.mocked(tools.link).mock.calls).toEqual([
      [`${KEG}/node/bin/node`, '/usr/local/bin/node'],
    ]);
    expect(ledger.outcomes().node?.status).toBe('failed');
  });
});
