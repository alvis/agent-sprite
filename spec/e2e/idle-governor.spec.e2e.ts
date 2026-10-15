import {
  mkdir,
  mkdtempDisposable,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { pathToFileURL } from 'node:url';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_ADAPTER,
  fixtureAccounts,
  fixtureCalls,
  fixtureProvider,
  writeFixtureAdapter,
} from '../fixtures/idle-root.js';
import {
  packageRoot,
  packedAwakeScript,
  packedPayloads,
  stage,
} from '../fixtures/packed-guest.js';

import type { ProviderComponent } from '#drivers/component-types';

const AWAKE_COMMAND = 'bin/open-agent-awake';
const AWAKE_DIRECTORY = 'run/awake';
const MANAGED_AWAKE_DIRECTORY = 'run/awake-root';
const COMMAND_MODE = 0o755;
const AWAKE_FILE_MODE = 0o640;
const USAGE_EXIT_CODE = 64;
const MINUTE = 60_000;
const T0 = Date.parse('2026-10-13T12:00:00.000Z');
const HOLDER = ['--source', 'claude', '--session', 'thr_01:live'];
/** longest Codex waits on a SessionEnd or Interrupt hook */
const CODEX_TEARDOWN_TIMEOUT_MS = 3_000;

/** a staged guest root with the packed kernel, a provider and the command */
interface GovernorRoot extends AsyncDisposable {
  /** absolute guest root */
  root: string;
  /** absolute path of the installed awake command */
  command: string;
}

/**
 * stages the packed kernel into a temporary guest root, records a provider
 * and the default idle options as the host would, creates the shared and the
 * managed awake directories and installs the command entry the packed host
 * writes
 * @param provider the provider the catalog records
 * @returns the guest root and its awake command
 */
async function stageGovernor(
  provider: ProviderComponent,
): Promise<GovernorRoot> {
  const packed = await packageRoot();
  const directory = await mkdtempDisposable(
    join(tmpdir(), 'open-agent-governor-'),
  );
  const root = await realpath(directory.path);
  const { frame } = await packedPayloads(packed);
  await stage(packed, root, frame);
  const catalog = JSON.parse(
    await readFile(join(root, 'components.json'), 'utf8'),
  ) as Record<string, unknown>;
  await writeFile(
    join(root, 'components.json'),
    JSON.stringify({ ...catalog, provider }),
  );
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      profile: { options: { idleTimeoutMinutes: 5, holdMaxMinutes: 60 } },
    }),
  );
  await mkdir(join(root, AWAKE_DIRECTORY), { recursive: true });
  await mkdir(join(root, MANAGED_AWAKE_DIRECTORY));
  await mkdir(join(root, 'bin'));
  const command = join(root, AWAKE_COMMAND);
  await writeFile(command, await packedAwakeScript(packed, root), {
    mode: COMMAND_MODE,
  });

  return {
    root,
    command,
    [Symbol.asyncDispose]: async () => directory[Symbol.asyncDispose](),
  };
}

/**
 * runs the installed awake command as a hook would
 * @param command absolute path of the awake command
 * @param args the command line
 * @param input what a harness writes to the hook's standard input
 * @returns the exit status and what the command wrote
 */
async function awake(
  command: string,
  args: readonly string[],
  input = '',
): Promise<{ exitCode?: number; output: string }> {
  const { exitCode, all } = await execa(command, args, {
    reject: false,
    all: true,
    input,
  });

  return { exitCode, output: all };
}

/**
 * reads the governor report the host reads, with the packed report entry
 * @param root absolute guest root
 * @returns the decoded report
 */
async function report(root: string): Promise<unknown> {
  const { stdout } = await execa(execPath, [
    join(root, 'guest/idle/report.js'),
  ]);

  return JSON.parse(stdout);
}

/**
 * runs a script against the staged kernel's own modules, with a fixed clock
 * and a trust check that accepts the test account's files
 * @param root absolute guest root
 * @param body script body; `kernel(name)` imports a staged idle module and
 * `context(now)` builds the governor context of an agent-account caller
 * @returns the JSON the script wrote
 */
async function withStagedKernel(root: string, body: string): Promise<unknown> {
  const kernel = pathToFileURL(join(root, 'guest/idle/')).href;
  const source = `
    const kernel = async (name) => import(new URL(name, ${JSON.stringify(kernel)}).href);
    const context = (now) => ({
      root: ${JSON.stringify(root)},
      owners: new Set([process.getuid()]),
      managedOwners: new Set([process.getuid()]),
      asRoot: false,
      now: () => now,
      trust: async (path) => path,
      applyAsAgent: async () => {
        throw new Error('only a root caller starts the agent-account apply');
      },
    });
    const event = { action: 'heartbeat', source: 'claude', session: 'thr_01' };
    ${body}
  `;
  const { stdout } = await execa(execPath, [
    '--input-type=module',
    '-e',
    source,
  ]);

  return JSON.parse(stdout);
}

describe('packed open-agent-awake', () => {
  it('should record each event, hold and release the workstation, and exit 0', async () => {
    await using governor = await stageGovernor(fixtureProvider());
    // production trust refuses an adapter a non-root account owns, as every
    // file the test account writes is
    await writeFixtureAdapter(governor.root);

    const opened = [
      await awake(governor.command, ['heartbeat', ...HOLDER]),
      await awake(governor.command, ['hold-open', ...HOLDER]),
    ];
    const whileHeld = await report(governor.root);
    const closed = await awake(governor.command, ['hold-close', ...HOLDER]);
    const afterRelease = await report(governor.root);
    const entries = (
      await readdir(join(governor.root, AWAKE_DIRECTORY))
    ).sort();
    const modes = await Promise.all(
      entries.map(
        async (entry) =>
          (await stat(join(governor.root, AWAKE_DIRECTORY, entry))).mode &
          0o777,
      ),
    );

    expect([...opened, closed]).toEqual([
      { exitCode: 0, output: '' },
      { exitCode: 0, output: '' },
      { exitCode: 0, output: '' },
    ]);
    expect(whileHeld).toEqual({
      recorded: true,
      state: expect.objectContaining({
        keepAwakeMode: 'native-deadline',
        idleTimeoutMinutes: 5,
        holdMaxMinutes: 60,
        lastHeartbeat: expect.any(String),
        openHolds: 1,
        holds: [expect.objectContaining({ source: 'claude' })],
        sleepPermitted: false,
        adapter: expect.objectContaining({
          action: 'apply-deadline',
          failure: expect.stringContaining('Untrusted root execution path'),
        }),
      }),
    });
    expect(afterRelease).toEqual({
      recorded: true,
      state: expect.objectContaining({ openHolds: 0, holds: [] }),
    });
    expect(entries).toEqual([
      'governor.json',
      expect.stringMatching(/^h-[0-9a-f]{64}\.json$/),
    ]);
    expect(modes).toEqual([AWAKE_FILE_MODE, AWAKE_FILE_MODE]);
    expect(await fixtureCalls(governor.root)).toEqual([]);
  });

  it('should exit 0 for a refused event and 64 only for a command line without a known action', async () => {
    await using governor = await stageGovernor(
      fixtureProvider({ keepAwakeMode: 'none', awakeAdapter: undefined }),
    );

    const refused = await awake(governor.command, [
      'heartbeat',
      '--source',
      'claude',
      '--session',
      'a/b',
    ]);
    const recorded = await report(governor.root);
    const usage = [
      await awake(governor.command, []),
      await awake(governor.command, ['--help']),
    ];

    expect(refused).toEqual({ exitCode: 0, output: '' });
    expect(recorded).toEqual({
      recorded: true,
      state: expect.objectContaining({
        holds: [],
        diagnostics: [expect.stringContaining('refused an awake event')],
      }),
    });
    expect(usage).toEqual([
      {
        exitCode: USAGE_EXIT_CODE,
        output: expect.stringContaining('usage: open-agent-awake'),
      },
      {
        exitCode: USAGE_EXIT_CODE,
        output: expect.stringContaining('usage: open-agent-awake'),
      },
    ]);
  });

  it('should take the session of a hook event piped to it and keep the workstation awake only while the hold is open', async () => {
    await using governor = await stageGovernor(
      fixtureProvider({ keepAwakeMode: 'none', awakeAdapter: undefined }),
    );
    const hook = async (action: string, session = 'thr_01:hook') =>
      awake(
        governor.command,
        [action, '--source', 'claude', '--session', '-'],
        JSON.stringify({
          session_id: session,
          hook_event_name: 'UserPromptSubmit',
          prompt: 'a prompt that is not stored',
        }),
      );

    const opened = await hook('hold-open');
    const whileHeld = await report(governor.root);
    const beat = await hook('heartbeat');
    const closed = await hook('hold-close');
    const afterClose = await report(governor.root);
    const files = (await readdir(join(governor.root, AWAKE_DIRECTORY))).join();

    expect([opened, beat, closed]).toEqual([
      { exitCode: 0, output: '' },
      { exitCode: 0, output: '' },
      { exitCode: 0, output: '' },
    ]);
    expect(whileHeld).toEqual({
      recorded: true,
      state: expect.objectContaining({
        openHolds: 1,
        holds: [expect.objectContaining({ source: 'claude' })],
      }),
    });
    expect(afterClose).toEqual({
      recorded: true,
      state: expect.objectContaining({ openHolds: 0, holds: [] }),
    });
    // only the hash of the session is ever stored
    expect(files).not.toContain('thr_01');
  });

  it.each([
    [
      'the Codex session-end budget, recording the apply that ran out of time',
      '2000',
      expect.objectContaining({
        failure: 'the adapter did not finish within 1400 ms',
      }),
    ],
    [
      'the shortest budget, ending before the apply that outlasts it',
      '1000',
      expect.objectContaining({
        failure: expect.stringContaining('Untrusted root execution path'),
      }),
    ],
  ])(
    'should release the hold and exit 0 within %s while the deadline apply stalls',
    async (_, budget, adapter) => {
      await using governor = await stageGovernor(fixtureProvider());
      await writeFixtureAdapter(governor.root, FIXTURE_ADAPTER, 'stall');
      const input = JSON.stringify({
        session_id: 'thr_01:end',
        hook_event_name: 'SessionEnd',
      });
      const opened = await awake(
        governor.command,
        ['hold-open', '--source', 'codex', '--session', '-'],
        input,
      );
      // production trust refuses the test account's adapter, so the staged
      // entry runs with a trust check that accepts it and lets the apply hang
      const entry = pathToFileURL(join(governor.root, 'guest/idle/awake.js'));
      const started = performance.now();
      const closed = await execa(
        execPath,
        [
          '--input-type=module',
          '-e',
          `
            const { runAwakeProcess } = await import(${JSON.stringify(entry.href)});
            await runAwakeProcess(process.argv.slice(1), async () => ({
              root: ${JSON.stringify(governor.root)},
              owners: new Set([process.getuid()]),
              managedOwners: new Set([process.getuid()]),
              asRoot: false,
              now: Date.now,
              trust: async (path) => path,
              applyAsAgent: async () => {
                throw new Error('only a root caller starts the agent-account apply');
              },
            }), process.stdin);
          `,
          'hold-close',
          '--source',
          'codex',
          '--session',
          '-',
          '--budget-ms',
          budget,
        ],
        { reject: false, input },
      );
      const elapsedMs = performance.now() - started;

      expect([opened.exitCode, closed.exitCode]).toEqual([0, 0]);
      // Codex waits at most 3 s on a SessionEnd or Interrupt hook
      expect(elapsedMs).toBeLessThan(CODEX_TEARDOWN_TIMEOUT_MS);
      expect(await fixtureCalls(governor.root)).toEqual([
        { call: 'applyAwakeDeadline', deadline: expect.any(String) },
      ]);
      // the hold-close lands before the apply starts; only a command that
      // outlives the apply records it over the hold-open's refused apply
      expect(await report(governor.root)).toEqual({
        recorded: true,
        state: expect.objectContaining({ openHolds: 0, holds: [], adapter }),
      });
    },
  );

  it.each([
    ['malformed JSON', '{not json'],
    [
      'an event without a session_id',
      JSON.stringify({ hook_event_name: 'Stop' }),
    ],
    [
      'an event of more than 64 KiB',
      JSON.stringify({ session_id: 's'.repeat(70_000) }),
    ],
    ['no input', ''],
  ])('should count %s piped to it as idleness and exit 0', async (_, input) => {
    await using governor = await stageGovernor(
      fixtureProvider({ keepAwakeMode: 'none', awakeAdapter: undefined }),
    );

    const result = await awake(
      governor.command,
      ['hold-open', '--source', 'claude', '--session', '-'],
      input,
    );

    expect(result).toEqual({ exitCode: 0, output: '' });
    expect(await report(governor.root)).toEqual({
      recorded: true,
      state: expect.objectContaining({
        holds: [],
        diagnostics: [expect.stringContaining('refused an awake event')],
      }),
    });
  });

  it('should exit 0 when the event cannot be written or Node is missing', async () => {
    await using governor = await stageGovernor(
      fixtureProvider({ keepAwakeMode: 'none', awakeAdapter: undefined }),
    );
    await rm(join(governor.root, AWAKE_DIRECTORY), { recursive: true });
    const withoutNode = join(governor.root, 'bin/open-agent-awake-no-node');
    await writeFile(
      withoutNode,
      (await readFile(governor.command, 'utf8')).replace(
        execPath,
        join(governor.root, 'missing/node'),
      ),
      { mode: COMMAND_MODE },
    );

    const results = [
      await awake(governor.command, ['hold-open', ...HOLDER]),
      await awake(withoutNode, ['hold-open', ...HOLDER]),
    ];

    expect(results).toEqual([
      { exitCode: 0, output: '' },
      { exitCode: 0, output: '' },
    ]);
    expect(await readdir(join(governor.root, 'run'))).toEqual(['awake-root']);
  });
});

describe('packed idle governor adapters', () => {
  it('should accept the packed Sprite adapter from its own folder for the agent account', async () => {
    const sprite = {
      id: 'sprite',
      keepAwakeMode: 'native-deadline',
      wakeMode: 'url-traffic',
      supportsCliWakeSleep: false,
      maxAwakeDeadlineMinutes: null,
      servicesMode: 'native',
      transportNetworks: [],
      awakeAdapter: 'drivers/providers/sprite/guest/sprite-awake.js',
    } satisfies ProviderComponent;
    await using governor = await stageGovernor(sprite);
    const module = join(governor.root, sprite.awakeAdapter);

    const loaded = await withStagedKernel(
      governor.root,
      `
        const { loadAwakeAdapter } = await kernel('adapter.js');
        const loaded = await loadAwakeAdapter({
          root: ${JSON.stringify(governor.root)},
          provider: ${JSON.stringify(sprite)},
          trust: async (path) => path,
        });
        process.stdout.write(JSON.stringify({
          mode: loaded.mode,
          applies: typeof loaded.adapter.applyAwakeDeadline,
        }));
      `,
    );

    expect(loaded).toEqual({ mode: 'native-deadline', applies: 'function' });
    // the agent account runs it, so it stays readable and is never writable
    expect((await stat(module)).mode & 0o777).toBe(0o755);
  });

  it('should refuse a Sprite adapter outside the Sprite folder', async () => {
    const stray = {
      id: 'sprite',
      keepAwakeMode: 'native-deadline',
      wakeMode: 'url-traffic',
      supportsCliWakeSleep: false,
      maxAwakeDeadlineMinutes: null,
      servicesMode: 'native',
      transportNetworks: [],
      awakeAdapter: 'drivers/providers/fly/guest/sprite-awake.js',
    } satisfies ProviderComponent;
    await using governor = await stageGovernor(stray);

    const outcome = await withStagedKernel(
      governor.root,
      `
        const { loadAwakeAdapter } = await kernel('adapter.js');
        const failure = await loadAwakeAdapter({
          root: ${JSON.stringify(governor.root)},
          provider: ${JSON.stringify(stray)},
          trust: async (path) => path,
        }).then(() => 'loaded', (error) => error.message);
        process.stdout.write(JSON.stringify({ failure }));
      `,
    );

    expect(outcome).toEqual({
      failure: expect.stringContaining('is not an -awake module'),
    });
  });

  it('should hand the idle deadline to the adapter in the provider folder', async () => {
    await using governor = await stageGovernor(fixtureProvider());
    await writeFixtureAdapter(governor.root);

    const state = await withStagedKernel(
      governor.root,
      `
        const { handleAwakeEvent } = await kernel('governor.js');
        process.stdout.write(JSON.stringify(await handleAwakeEvent(context(${T0}), event)));
      `,
    );

    expect(state).toEqual(
      expect.objectContaining({
        deadline: new Date(T0 + 5 * MINUTE).toISOString(),
        adapter: {
          at: new Date(T0).toISOString(),
          action: 'apply-deadline',
          result: new Date(T0 + 5 * MINUTE).toISOString(),
        },
      }),
    );
    expect(await fixtureCalls(governor.root)).toEqual([
      {
        call: 'applyAwakeDeadline',
        deadline: new Date(T0 + 5 * MINUTE).toISOString(),
      },
    ]);
  });

  it("should apply a root caller's deadline in a child running as the agent account, never in root's process", async () => {
    await using governor = await stageGovernor(fixtureProvider());
    await writeFixtureAdapter(governor.root);
    // the child applies through the staged kernel with a trust check that
    // accepts the test account's files, which production trust refuses
    const child = join(governor.root, 'apply-as-agent.mjs');
    await writeFile(
      child,
      `
        const { applyLatestDeadline } = await import(${JSON.stringify(pathToFileURL(join(governor.root, 'guest/idle/apply.js')).href)});
        const result = await applyLatestDeadline({
          root: ${JSON.stringify(governor.root)},
          owners: new Set([process.getuid()]),
          managedOwners: new Set([process.getuid()]),
          asRoot: false,
          now: () => ${T0},
          trust: async (path) => path,
          applyAsAgent: async () => {
            throw new Error('the child is the agent account');
          },
        });
        process.stdout.write(JSON.stringify(result));
        process.exit(0);
      `,
    );

    const result = await withStagedKernel(
      governor.root,
      `
        const { handleAwakeEvent } = await kernel('governor.js');
        const { applyAsAgentAccount } = await kernel('agent-apply.js');
        const root = {
          ...context(${T0}),
          asRoot: true,
          applyAsAgent: async () =>
            applyAsAgentAccount({
              entry: ${JSON.stringify(child)},
              account: { uid: process.getuid(), gid: process.getgid() },
              limitMs: 2500,
              at: new Date(${T0}).toISOString(),
            }),
        };
        const state = await handleAwakeEvent(root, { ...event, action: 'hold-open' });
        process.stdout.write(JSON.stringify({ state, pid: process.pid }));
      `,
    );
    const accounts = await fixtureAccounts(governor.root);

    expect(accounts).toEqual([
      expect.objectContaining({ event: 'import', uid: process.getuid?.() }),
      expect.objectContaining({
        event: 'applyAwakeDeadline',
        uid: process.getuid?.(),
      }),
    ]);
    expect(accounts.map(({ uid }) => uid)).not.toContain(0);
    // root's own process never loaded the adapter
    expect(result).toEqual({
      state: expect.objectContaining({
        openHolds: 1,
        deadline: new Date(T0 + 60 * MINUTE).toISOString(),
        adapter: {
          at: new Date(T0).toISOString(),
          action: 'apply-deadline',
          result: new Date(T0 + 60 * MINUTE).toISOString(),
        },
      }),
      pid: expect.not.toBeOneOf(accounts.map(({ pid }) => pid)),
    });
    expect(await readdir(join(governor.root, MANAGED_AWAKE_DIRECTORY))).toEqual(
      [expect.stringMatching(/^h-[0-9a-f]{64}\.json$/)],
    );
  });

  it('should run the shipped apply entry with no arguments and print only its result', async () => {
    await using governor = await stageGovernor(fixtureProvider());
    await writeFixtureAdapter(governor.root);

    const { exitCode, stdout } = await execa(
      execPath,
      [join(governor.root, 'guest/idle/apply.js')],
      { reject: false },
    );

    expect(exitCode).toBe(0);
    // production trust refuses an adapter a non-root account owns
    expect(JSON.parse(stdout)).toEqual({
      at: expect.any(String),
      action: 'apply-deadline',
      failure: expect.stringContaining('Untrusted root execution path'),
    });
    expect(await fixtureAccounts(governor.root)).toEqual([]);
  });

  it('should enter the idle form of a governed provider once the deadline passes', async () => {
    await using governor = await stageGovernor(
      fixtureProvider({ keepAwakeMode: 'governed' }),
    );
    await writeFixtureAdapter(governor.root);

    const adapters = await withStagedKernel(
      governor.root,
      `
        const { handleAwakeEvent, tick } = await kernel('governor.js');
        await handleAwakeEvent(context(${T0}), event);
        const adapters = [];
        for (const minutes of [0, 2, 4, 6]) {
          adapters.push((await tick(context(${T0} + minutes * ${MINUTE}))).adapter ?? null);
        }
        process.stdout.write(JSON.stringify(adapters));
      `,
    );

    expect(adapters).toEqual([
      null,
      null,
      null,
      {
        at: new Date(T0 + 6 * MINUTE).toISOString(),
        action: 'enter-idle-form',
        result: 'memory-suspend',
      },
    ]);
    expect(await fixtureCalls(governor.root)).toEqual([
      { call: 'enterIdleForm' },
    ]);
  });

  it.each([
    [
      'in another provider folder',
      'drivers/providers/other/guest/other-awake.js',
    ],
    [
      'without the -awake suffix',
      'drivers/providers/fixture/guest/fixture-deadline.js',
    ],
    [
      'below the provider guest folder',
      'drivers/providers/fixture/guest/nested/fixture-awake.js',
    ],
  ])(
    'should refuse a recorded adapter %s without loading it',
    async (...[, module]) => {
      await using governor = await stageGovernor(
        fixtureProvider({ awakeAdapter: module }),
      );
      await writeFixtureAdapter(governor.root, module);

      const result = await withStagedKernel(
        governor.root,
        `
          const { handleAwakeEvent } = await kernel('governor.js');
          const { loadAwakeAdapter } = await kernel('adapter.js');
          const state = await handleAwakeEvent(context(${T0}), event);
          const trusted = [];
          const loaded = await loadAwakeAdapter({
            root: ${JSON.stringify(governor.root)},
            provider: {
              id: 'fixture',
              keepAwakeMode: 'native-deadline',
              wakeMode: 'url-traffic',
              supportsCliWakeSleep: false,
              awakeAdapter: ${JSON.stringify(module)},
            },
            trust: async (path) => {
              trusted.push(path);
              return path;
            },
          }).then(() => 'loaded', (error) => error.message);
          process.stdout.write(JSON.stringify({ state, loaded, trusted }));
        `,
      );

      expect(result).toEqual({
        state: expect.objectContaining({
          diagnostics: expect.arrayContaining([
            expect.stringContaining('recorded provider is malformed'),
          ]),
        }),
        loaded: expect.stringContaining(
          "is not an -awake module of the provider's own guest folder",
        ),
        trusted: [],
      });
      expect(result).not.toHaveProperty('state.adapter');
      expect(await fixtureCalls(governor.root, module)).toEqual([]);
    },
  );
});
