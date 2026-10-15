import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import {
  mkdir,
  mkdtempDisposable,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, posix, relative } from 'node:path';
import { execPath } from 'node:process';
import { pathToFileURL } from 'node:url';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

import {
  packageRoot,
  packedAwakeScript,
  packedNetworkSelection,
  packedPayloads,
  runStage,
  stage,
} from '../fixtures/packed-guest.js';

import type { AddressInfo } from 'node:net';

import type { PackedPayloads } from '../fixtures/packed-guest.js';

/** a guest module staged under the temporary guest root */
interface StagedModule {
  name: string;
  mode: number;
  uid: number;
  source: string;
}

// root runs these directly although they are staged for every account: the
// awake command runs as root for managed operations, a managed operation
// holds the workstation awake as root, and the host reads the governor report
// as root
const ROOT_ENTRY_MODULES = [
  'guest/guest-transaction.js',
  'guest/idle/awake.js',
  'guest/idle/hold.js',
  'guest/idle/report.js',
];
// the idle governor's entries: the awake command, the managed-operation hold,
// the agent-account deadline apply and the report; none may control a service
const IDLE_ENTRY_MODULES = [
  'guest/idle/apply.js',
  'guest/idle/awake.js',
  'guest/idle/hold.js',
  'guest/idle/report.js',
];
/** an awake adapter the governor loads at run time from the recorded catalog */
const AWAKE_ADAPTER =
  /^drivers\/providers\/[a-z0-9-]+\/guest\/[a-z0-9-]+-awake\.js$/;
const ROOT_SCRIPT_MODE = 0o700;
const SHARED_SCRIPT_MODE = 0o755;
const SHARED_DIRECTORY_MODE = 0o755;
// anything that could stop, start, restart, register, signal or delete a
// supervised service or its process: the management CLI, init and supervisor
// tools, the service verbs in prose or as split command arguments, a service
// API path, supervisor sockets, and every way to signal a process
const SERVICE_CONTROL = new RegExp(
  [
    String.raw`sprite-env`,
    String.raw`\bsystemctl\b`,
    String.raw`\bsupervisorctl\b`,
    String.raw`\bservice\s+[\w.@-]+\s+(?:start|stop|restart|reload)\b`,
    String.raw`\bservices?\b['"\`,\s\[\]]{1,12}(?:list|get|stop|start|restart|create|delete|signal)\b`,
    String.raw`['"\`]services?['"\`]`,
    String.raw`/v1/services\b`,
    String.raw`\/\.sprite\b`,
    String.raw`api\.sock`,
    String.raw`\b(?:p|k)?kill(?:all)?\b`,
    String.raw`\.kill\(`,
  ].join('|'),
);
// the one use of the Sprite local API the awake adapter makes: its own task
const SPRITE_TASK_SOCKET = "const SPRITE_API_SOCKET = '/.sprite/api.sock';";
const SPRITE_ADAPTER = 'drivers/providers/sprite/guest/sprite-awake.js';
// the shell idle governor, its awake command, and the provider adapters it runs
const AWAKE_SCRIPT = 'guest/awake.sh';
// each with the one line it may have that looks like service control: the
// Sprite adapter's socket, which it uses for its own task alone
const AWAKE_ADAPTER_SCRIPTS: ReadonlyMap<string, string | undefined> = new Map([
  ['drivers/providers/fly-machine/guest/fly-machine-awake.sh', undefined],
  [
    'drivers/providers/sprite/guest/sprite-awake.sh',
    'OA_SPRITE_SOCKET=/.sprite/api.sock',
  ],
]);
const BOOTSTRAP_SCRIPT = 'guest/bootstrap-node.sh';
// the cron gate runs as root every hour and runs the updater once an update
// is due
const UPDATE_GATE_SCRIPT = 'guest/update-gate.sh';
// the shell updater and every library the gate sources for it
const UPDATER_SCRIPTS = [
  UPDATE_GATE_SCRIPT,
  'guest/updater.sh',
  'os/debian/update-system.sh',
  'tools/homebrew/lib.sh',
  'tools/npm/lib.sh',
  'tools/rustup/lib.sh',
  'tools/links.sh',
];
// the debian family's library the updater sources too: setup alone masks a
// service with it, so its masking function is left out of the scan
const FAMILY_LIBRARY = 'os/debian/lib.sh';
const MASK_FUNCTION = /^oa_mask_service\(\) \{[\s\S]*?^\}$/m;
// the only signals guest modules send, each to processes of their own: signal
// 0 asks whether a lock creator's process exists and sends nothing, the apply
// handoff ends its own agent-account child, first asking it to stop and then
// killing it, and a managed operation ends the process group of a child it
// started, or passes on a signal that ends it and then lets the signal end it
const OWN_PROCESS_SIGNALS: ReadonlyMap<string, readonly string[]> = new Map([
  ['guest/idle/lock.js', ['process.kill(pid, 0);']],
  [
    'guest/idle/agent-apply.js',
    ["child.kill('SIGTERM');", "child.kill('SIGKILL');"],
  ],
  [
    'guest/run-child.js',
    ['process.kill(-child.pid, signal);', 'process.kill(process.pid, signal);'],
  ],
]);
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bnew URL\(\s*)['"]([^'"]+)['"]/g;

/**
 * tells whether a staged module could control a service, once the signals
 * guest modules send to their own processes are set aside
 * @param name deployed module name
 * @param source the module's source
 * @returns whether anything beyond those signals matches service control
 */
function controlsServices(name: string, source: string): boolean {
  const allowed = OWN_PROCESS_SIGNALS.get(name) ?? [];

  return SERVICE_CONTROL.test(
    allowed.reduce(
      (remaining, signal) => remaining.replaceAll(signal, ''),
      executableLines(source),
    ),
  );
}

/**
 * lists every staged guest module with its owner and mode
 * @param guestRoot temporary guest root
 * @returns staged modules keyed by deployed name
 */
async function stagedModules(
  guestRoot: string,
): Promise<Map<string, StagedModule>> {
  const entries = await readdir(guestRoot, {
    recursive: true,
    withFileTypes: true,
  });
  const modules = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        const { mode, uid } = await stat(path);

        return {
          name: relative(guestRoot, path).split('\\').join('/'),
          mode: mode & 0o777,
          uid,
          source: await readFile(path, 'utf8'),
        };
      }),
  );

  return new Map(modules.map((module) => [module.name, module]));
}

/**
 * lists the module specifiers a compiled guest module loads
 * @param module staged module
 * @returns relative specifiers resolved to deployed names, and bare specifiers
 */
function specifiersOf(module: StagedModule): {
  relative: string[];
  bare: string[];
} {
  const specifiers = [...module.source.matchAll(SPECIFIER)].map(
    ([, specifier]) => specifier!,
  );

  return {
    relative: specifiers
      .filter((specifier) => specifier.startsWith('.'))
      .map((specifier) =>
        posix.normalize(posix.join(posix.dirname(module.name), specifier)),
      ),
    bare: specifiers.filter((specifier) => !specifier.startsWith('.')),
  };
}

/**
 * collects every module reachable through static imports from the seeds
 * @param modules staged modules
 * @param seeds deployed names to start from
 * @returns deployed names in the import graph, seeds included
 */
function importGraph(
  modules: Map<string, StagedModule>,
  seeds: readonly string[],
): Set<string> {
  const pending = [...seeds];
  const graph = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop()!;
    const module = modules.get(name);
    if (!graph.has(name) && module) {
      graph.add(name);
      pending.push(...specifiersOf(module).relative);
    }
  }

  return graph;
}

/**
 * drops the lines that only document or map the code, so prose does not
 * count as a call
 * @param source the module's compiled text
 * @returns the source without its comment lines
 */
function executableLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

/**
 * drops the comment lines of a shell script, which may describe what it never does
 * @param source shell script text
 * @returns the lines that execute
 */
function shellExecutableLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * collects every module root loads, starting from the modules root executes
 * and the awake adapters a root tick loads through the catalog: every adapter
 * declared for root, which is every `governed` one
 * @param modules staged modules
 * @param declared driver modules and the account each is declared for
 * @returns deployed names in root's import graph
 */
function rootImportGraph(
  modules: Map<string, StagedModule>,
  declared: PackedPayloads['declared'] = [],
): Set<string> {
  return importGraph(modules, [
    ...[...modules.values()]
      .filter(({ mode }) => mode === ROOT_SCRIPT_MODE)
      .map(({ name }) => name),
    ...ROOT_ENTRY_MODULES,
    ...declared
      .filter(
        ({ module, account }) =>
          account === 'root' && AWAKE_ADAPTER.test(module),
      )
      .map(({ module }) => module),
  ]);
}

// a compile step anywhere on the guest's install and update path: a kernel.org
// source feed, a compiler, a build tool or a configure script, the toolchain
// package or a development headers package an apt line names, or Homebrew told
// to build from source
const SOURCE_BUILD = new RegExp(
  [
    String.raw`kernel\.org`,
    String.raw`['"\`/](?:make|gcc|g\+\+|cc|nproc|cmake|node-gyp)['"\`]`,
    String.raw`\bcargo\s+build\b`,
    String.raw`\.\/configure\b`,
    String.raw`build-essential`,
    String.raw`['"\`\s][a-z0-9][a-z0-9.+-]*-dev\b(?!-)`,
    String.raw`--build-from-source\b`,
    String.raw`HOMEBREW_BUILD_FROM_SOURCE`,
    String.raw`\$\(nproc\)`,
  ].join('|'),
);

// the one place the guest names the compiler: distro packages the linker of
// cargo and pip needs, installed from the distro's own binaries and never
// used by the installer to compile anything
const APPROVED_COMPILER_PACKAGES = /const COMPILER_PACKAGES = \[[^\]]*\];/gu;

/** what a packed Git component did through a fake Homebrew */
interface PackedGitRun {
  /** every program run, as root, as the agent, or as the prefix's account */
  calls: string[][];
  /** the outcomes the ledger recorded */
  outcomes: Record<string, { status: string; version?: string }>;
  /** the lines the ledger noted */
  notes: string[];
}

/**
 * runs the staged Git component and Homebrew module, in their own Node
 * process, against a Homebrew whose brew answers from a table
 * @param guestRoot staged guest root
 * @param scratch directory for the fake prefix
 * @param bottles bottle platforms of Git's one dependency
 * @returns what the component ran and recorded
 */
async function runPackedGit(
  guestRoot: string,
  scratch: string,
  bottles: readonly string[],
): Promise<PackedGitRun> {
  const module = (name: string): string =>
    JSON.stringify(pathToFileURL(join(guestRoot, 'guest', name)).href);
  const source = `
    import { mkdir, writeFile } from 'node:fs/promises';
    const { formulaComponent } = await import(${module('install-tools/formula.js')});
    const { HOMEBREW_TOOLS } = await import(${module('homebrew.js')});
    const { homebrew } = await import(${module('install-tools/homebrew.js')});
    const { ComponentLedger } = await import(${module('install-tools/ledger.js')});
    const prefix = ${JSON.stringify(join(scratch, 'home', '.linuxbrew'))};
    const layout = { account: 'linuxbrew', home: ${JSON.stringify(join(scratch, 'home'))}, prefix, brew: prefix + '/bin/brew' };
    const account = 'linuxbrew:x:' + process.getuid() + ':' + process.getgid() + '::' + layout.home + ':/usr/sbin/nologin\\n';
    await mkdir(prefix + '/bin', { recursive: true });
    await writeFile(layout.brew, '');
    const calls = [];
    const notes = [];
    let linked = false;
    const bottle = (name, tags) => ({ name, versions: { stable: name === 'git' ? '2.56.0' : '1.0.0' },
      bottle: { stable: { files: Object.fromEntries(tags.map((tag) => [tag, {}])) } } });
    const runAsHomebrew = async (program, args) => {
      calls.push(['linuxbrew', program, ...args]);
      if (args[0] === 'deps') return 'curl\\n';
      if (args[0] === 'outdated') return JSON.stringify({ formulae: [], casks: [] });
      if (args[0] === 'info') return JSON.stringify({ formulae: args.slice(2).map((name) =>
        bottle(name, name === 'curl' ? ${JSON.stringify(bottles)} : ['x86_64_linux', 'arm64_linux'])) });
      return '';
    };
    const tools = {
      run: async (program, args) => {
        calls.push([program, ...args]);
        if (program === '/usr/bin/getent' && args[0] === 'passwd') return account;
        return args.includes('--version') && linked ? 'git version 2.56.0\\n' : '';
      },
      downloadText: async () => { throw new Error('nothing is downloaded'); },
      download: async () => { throw new Error('nothing is downloaded'); },
      link: async (target, path) => { calls.push(['link', target, path]); linked = true; },
      temporary: ${JSON.stringify(scratch)},
      toolsDirectory: ${JSON.stringify(join(scratch, 'tools'))},
    };
    const ledger = new ComponentLedger((line) => notes.push(line));
    await ledger.ensure(formulaComponent(tools, { ...homebrew(tools, runAsHomebrew, { layout, systemUidMax: Number.MAX_SAFE_INTEGER }), owns: async (path) => path.startsWith(prefix) || linked }, HOMEBREW_TOOLS.find((tool) => tool.formula === 'git')));
    process.stdout.write(JSON.stringify({ calls, outcomes: ledger.outcomes(), notes }));
  `;
  const { stdout } = await execa(
    execPath,
    ['--input-type=module', '-e', source],
    { cwd: scratch },
  );

  return JSON.parse(stdout) as PackedGitRun;
}

describe('packed guest payload staging', () => {
  it('should stage every module a deployed module imports', async () => {
    const root = await packageRoot();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-payloads-'),
    );
    const { frame } = await packedPayloads(root);
    await stage(root, directory.path, frame);
    const modules = await stagedModules(directory.path);
    const catalog = JSON.parse(
      await readFile(join(directory.path, 'components.json'), 'utf8'),
    ) as { networks: Array<{ installer: string }>; packages: string[] };

    const unresolved = [...modules.values()].flatMap((module) =>
      specifiersOf(module)
        .relative.filter((name) => !modules.has(name))
        .map((name) => `${module.name} -> ${name}`),
    );
    const foreign = [...modules.values()].flatMap((module) =>
      specifiersOf(module)
        // the only packages a guest module may load are the ones the guest
        // installs beside the core scripts
        .bare.filter(
          (specifier) =>
            !specifier.startsWith('node:') &&
            !catalog.packages.includes(specifier),
        )
        .map((specifier) => `${module.name} -> ${specifier}`),
    );

    expect(modules.size).toBe(
      frame.filter(({ name }) => name.endsWith('.js')).length + 1,
    );
    expect(unresolved).toEqual([]);
    expect(foreign).toEqual([]);
    // the staged list is a seed; the host records the selected network's
    // installer over it, and that installer is among the staged modules
    expect(catalog.networks).toEqual([]);
    const { catalog: selected } = await packedNetworkSelection(
      root,
      'tailscale',
    );
    expect(selected.networks.length).toBeGreaterThan(0);
    for (const { installer } of selected.networks) {
      expect(modules.has(installer)).toBe(true);
    }
  });

  it('should stage the guest for the none profile yet install no network tool and make the agent service depend on no network', async () => {
    const root = await packageRoot();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-payloads-none-'),
    );
    const { frame } = await packedPayloads(root);
    await stage(root, directory.path, frame);
    const modules = await stagedModules(directory.path);

    const none = await packedNetworkSelection(root, 'none');
    const tailscale = await packedNetworkSelection(root, 'tailscale');

    // staging is independent of the profile: Tailscale's installer is on the
    // guest whatever is selected, but only a selected network's installer is
    // recorded for the guest to run, and nothing is registered for `none`
    const [installer] = tailscale.catalog.networks.map(
      ({ installer: module }) => module,
    );
    expect(installer).toBeDefined();
    expect(modules.has(installer ?? '')).toBe(true);
    expect(none.catalog.networks).toEqual([]);
    expect(JSON.stringify(none.catalog)).not.toMatch(/tailscale/iu);
    expect(none.agentNeeds).toEqual([]);
    expect(tailscale.catalog.networks.map(({ id }) => id)).toEqual([
      'tailscale',
    ]);
    expect(tailscale.agentNeeds).toEqual(['tailscaled']);
  });

  it('should keep root import graph unwritable by other accounts, untransferred, and free of agent-writable packages', async () => {
    const root = await packageRoot();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-root-graph-'),
    );
    const { frame, declared } = await packedPayloads(root);
    await stage(root, directory.path, frame);
    const modules = await stagedModules(directory.path);
    const stagingUid = process.getuid?.() ?? 0;

    const graph = rootImportGraph(modules, declared);
    // a native-deadline adapter is declared for the agent account and so is
    // caught here should root ever load it
    const nonRoot = declared.filter(
      ({ module, account }) => account !== 'root' && graph.has(module),
    );
    // staging runs as the test user, so this proves only that the worker never
    // handed a module to another account and left no group or other write bit;
    // the uid 0 ownership of the real guest is proven by the live suite
    const exposed = [...graph].filter((name) => {
      const module = modules.get(name);

      return module?.uid !== stagingUid || (module.mode & 0o022) !== 0;
    });
    // `ws` resolves through the agent's home on the guest, so root must never
    // load it or any other package; only node: built-ins are root-safe
    const packages = [...graph].flatMap((name) =>
      specifiersOf(modules.get(name)!)
        .bare.filter((specifier) => !specifier.startsWith('node:'))
        .map((specifier) => `${name} -> ${specifier}`),
    );

    expect([...graph]).toEqual(
      expect.arrayContaining([
        'guest/idle/hold.js',
        'guest/install-tools.js',
        'guest/updater.js',
        'guest/component-catalog.js',
        'guest/harness-catalog.js',
        'drivers/networks/tailscale/guest/tailscale-install.js',
      ]),
    );
    expect(nonRoot).toEqual([]);
    expect(exposed).toEqual([]);
    expect(packages).toEqual([]);
  });

  it('should not let a readable module import a root-only one', async () => {
    const root = await packageRoot();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-readable-'),
    );
    const { frame } = await packedPayloads(root);
    await stage(root, directory.path, frame);
    const modules = await stagedModules(directory.path);

    // an agent-run script that imports a 0700 module would fail on the guest
    const unreadable = [...modules.values()]
      .filter(({ mode }) => mode === SHARED_SCRIPT_MODE)
      .flatMap((module) =>
        specifiersOf(module)
          .relative.filter(
            (name) => modules.get(name)?.mode === ROOT_SCRIPT_MODE,
          )
          .map((name) => `${module.name} -> ${name}`),
      );

    expect(unreadable).toEqual([]);
  });

  it('should find a package import in a root module when one is added', () => {
    const modules = new Map<string, StagedModule>([
      [
        'guest/install-tools.js',
        {
          name: 'guest/install-tools.js',
          mode: ROOT_SCRIPT_MODE,
          uid: 0,
          source: "import { helper } from './helper.js';\n",
        },
      ],
      [
        'guest/helper.js',
        {
          name: 'guest/helper.js',
          mode: 0o755,
          uid: 0,
          source: "import WebSocket from 'ws';\n",
        },
      ],
    ]);

    const graph = rootImportGraph(modules);

    expect([...graph]).toContain('guest/helper.js');
    expect(specifiersOf(modules.get('guest/helper.js')!).bare).toEqual(['ws']);
  });

  it('should hold a governed awake adapter to the root graph although nothing imports it', () => {
    const adapter = 'drivers/providers/fixture/guest/fixture-awake.js';
    const modules = new Map<string, StagedModule>([
      [
        adapter,
        {
          name: adapter,
          mode: SHARED_SCRIPT_MODE,
          uid: 0,
          source: "import WebSocket from 'ws';\n",
        },
      ],
    ]);

    const governed = rootImportGraph(modules, [
      { module: adapter, account: 'root' },
    ]);
    const native = rootImportGraph(modules, [
      { module: adapter, account: 'agent' },
    ]);

    expect([...governed]).toEqual([adapter]);
    expect([...native]).toEqual([]);
  });

  it('should match every service-control form the proof searches for', () => {
    const forbidden = [
      "execFileSync('sprite-env', ['services', 'restart', 'tailscaled'])",
      "spawn('systemctl', ['restart', 'tailscaled'])",
      "run('supervisorctl', ['stop', 'x'])",
      "run('service', ['tailscaled', 'restart'])",
      'run(`sprite-env services stop x`)',
      "const verbs = ['services', 'stop'];",
      "fetch('http://sprite/v1/services/t3-code/stop')",
      "requestHttp({ socketPath: '/.sprite/api.sock' })",
      "execFileSync('pkill', ['-f', 'tailscaled'])",
      "execFileSync('killall', ['tailscaled'])",
      'process.kill(pid, 15);',
      "child.kill('SIGTERM');",
    ];
    const clean = [
      "const services = await readFile('components.json');",
      "execFileSync(node, [installer, '--force']);",
      '// restart is described here but never called',
      "const killing = 'without killing the writer';",
    ];

    expect(forbidden.filter((line) => !SERVICE_CONTROL.test(line))).toEqual([]);
    expect(
      [
        'systemctl restart tailscaled',
        'kill -TERM "$pid"',
        'pkill -f tailscaled',
        'sprite-env services stop x',
      ].filter((line) => !SERVICE_CONTROL.test(shellExecutableLines(line))),
    ).toEqual([]);
    expect(
      SERVICE_CONTROL.test(
        shellExecutableLines(
          '# systemctl restart is never called\nrm -rf "$tree"',
        ),
      ),
    ).toBe(false);
    expect(
      clean.filter((line) => SERVICE_CONTROL.test(executableLines(line))),
    ).toEqual([]);
  });

  it('should give the updater, its installers and the awake hold it runs in no way to control a service', async () => {
    const root = await packageRoot();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-updater-graph-'),
    );
    const { frame } = await packedPayloads(root);
    await stage(root, directory.path, frame);
    const modules = await stagedModules(directory.path);
    const { catalog } = await packedNetworkSelection(root, 'tailscale');

    // the updater runs install-tools as a child process and holds the
    // workstation awake in process, and install-tools imports each network installer by a computed path, so
    // none of them is reachable from the updater's static imports
    const graph = importGraph(modules, [
      'guest/updater.js',
      'guest/install-tools.js',
      ...catalog.networks.map(({ installer }) => installer),
    ]);
    // the Node gate is a shell script the install runs as root, outside the
    // import graph, and it prunes whole trees beside the live one; the packed
    // package ships it beside the compiled kernel, the launcher deploys it
    const bootstrap = await readFile(
      join(root, 'lib', BOOTSTRAP_SCRIPT),
      'utf8',
    );
    // the cron gate and the shell updater it runs, with every library it
    // sources: none of them may control a service, and none masks one
    const updater = new Map(
      await Promise.all(
        [...UPDATER_SCRIPTS, FAMILY_LIBRARY].map(
          async (name) =>
            [
              name,
              shellExecutableLines(
                await readFile(join(root, 'lib', name), 'utf8'),
              ),
            ] as const,
        ),
      ),
    );
    const family = updater.get(FAMILY_LIBRARY)!;
    updater.set(FAMILY_LIBRARY, family.replace(MASK_FUNCTION, ''));
    const controlling = [
      ...[...graph].filter((name) =>
        controlsServices(name, modules.get(name)!.source),
      ),
      ...(SERVICE_CONTROL.test(shellExecutableLines(bootstrap))
        ? [BOOTSTRAP_SCRIPT]
        : []),
      ...[...updater]
        .filter(([, source]) => SERVICE_CONTROL.test(source))
        .map(([name]) => name),
    ];
    const masking = UPDATER_SCRIPTS.filter((name) =>
      updater.get(name)!.includes('oa_mask_service'),
    );
    expect([...graph]).toEqual(
      expect.arrayContaining([
        'guest/updater.js',
        'guest/update-versions.js',
        'guest/idle/hold.js',
        'guest/install-tools.js',
        'guest/install-tools/networks.js',
        'drivers/networks/tailscale/guest/tailscale-install.js',
      ]),
    );
    expect(bootstrap).toContain('prune_trees');
    expect(family).toMatch(MASK_FUNCTION);
    expect(updater.get(UPDATE_GATE_SCRIPT)).toContain('oa_update_run');
    expect(masking).toEqual([]);
    expect(modules.has('guest/update-services.js')).toBe(false);
    expect(modules.has('guest/updater/services.js')).toBe(false);
    expect(controlling).toEqual([]);
    expect(modules.has('guest/updater-lifecycle.js')).toBe(false);
  });

  it('should stage an install and update path that builds nothing from source', async () => {
    const root = await packageRoot();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-no-build-'),
    );
    const { frame } = await packedPayloads(root);
    await stage(root, directory.path, frame);
    const modules = await stagedModules(directory.path);
    const scripts = await Promise.all(
      [BOOTSTRAP_SCRIPT, ...UPDATER_SCRIPTS].map(async (name) => ({
        name,
        source: shellExecutableLines(
          await readFile(join(root, 'lib', name), 'utf8'),
        ),
      })),
    );

    expect(
      [
        ...[...modules.values()].map(({ name, source }) => ({
          name,
          source: executableLines(source).replaceAll(
            APPROVED_COMPILER_PACKAGES,
            '',
          ),
        })),
        ...scripts,
      ]
        .filter(({ source }) => SOURCE_BUILD.test(source))
        .map(({ name }) => name),
    ).toEqual([]);
    expect([...importGraph(modules, ['guest/install-tools.js'])]).toEqual(
      expect.arrayContaining([
        'guest/install-tools/formula.js',
        'guest/install-tools/homebrew.js',
        'guest/homebrew.js',
      ]),
    );
    expect(modules.get('guest/install-tools/formula.js')!.mode).toBe(
      ROOT_SCRIPT_MODE,
    );
    expect(modules.get('guest/install-tools/homebrew.js')!.mode).toBe(
      ROOT_SCRIPT_MODE,
    );
  });

  it('should find every source build the proof searches for', () => {
    expect(
      [
        "const GIT_FEED = 'https://mirrors.edge.kernel.org/pub/software/scm/git/';",
        "await run('/usr/bin/make', ['-C', source, 'all']);",
        "await run('/usr/bin/nproc', [], true);",
        "spawn('node-gyp', ['rebuild']);",
        "execFileSync('cargo build --release');",
        "await run('./configure', []);",
        "'build-essential',",
        "'libssl-dev',",
        "'zlib1g-dev',",
        "'libcurl4-openssl-dev',",
        "await homebrew.run(['install', '--build-from-source', 'git']);",
        'HOMEBREW_BUILD_FROM_SOURCE=1 brew install git',
        'make -j$(nproc)',
        "await run('/usr/bin/gcc', ['-c', 'main.c']);",
        "const PACKAGES = ['gcc', 'libc6-dev'];",
      ].filter((line) => !SOURCE_BUILD.test(line)),
    ).toEqual([]);
    expect(
      [
        "'git', 'curl', 'ca-certificates', 'procps', 'file', 'unzip', 'cron'",
        "'iputils-ping', 'telnet', 'dnsutils', 'netcat-openbsd', 'wget'",
        "await homebrew.run(['install', 'git']);",
        "'node-dev-tools',",
        "const make = 'compile-time';",
        "'--no-install-recommends',",
        "const COMPILER_PACKAGES = ['gcc', 'libc6-dev'];".replaceAll(
          APPROVED_COMPILER_PACKAGES,
          '',
        ),
      ].filter((line) => SOURCE_BUILD.test(line)),
    ).toEqual([]);
  });

  it('should take Git from its Homebrew bottle through brew and link it', async () => {
    const root = await packageRoot();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-packed-git-'),
    );
    const { frame } = await packedPayloads(root);
    await stage(root, join(directory.path, 'guest-root'), frame);
    await mkdir(join(directory.path, 'scratch'));

    const { calls, outcomes } = await runPackedGit(
      join(directory.path, 'guest-root'),
      join(directory.path, 'scratch'),
      ['x86_64_linux', 'arm64_linux'],
    );

    const brew = join(
      directory.path,
      'scratch',
      'home',
      '.linuxbrew',
      'bin',
      'brew',
    );
    expect(
      calls
        .filter(([account]) => account === 'linuxbrew')
        .map(([, program, ...args]) => [program, ...args]),
    ).toEqual([
      [brew, 'update'],
      [brew, 'info', '--json=v2', 'git'],
      [brew, 'deps', 'git'],
      [brew, 'info', '--json=v2', 'git', 'curl'],
      [brew, 'install', 'git'],
      [brew, 'outdated', '--json=v2'],
    ]);
    expect(calls).toContainEqual([
      'link',
      join(
        directory.path,
        'scratch',
        'home',
        '.linuxbrew',
        'opt',
        'git',
        'bin',
        'git',
      ),
      '/usr/local/bin/git',
    ]);
    expect(calls.flat().join(' ')).not.toMatch(/\/usr\/bin\/(?:make|tar)\b/);
    expect(outcomes).toEqual({
      git: { status: 'installed', version: '2.56.0' },
    });
  });

  it('should fail the packed Git component without building when a dependency has no bottle', async () => {
    const root = await packageRoot();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-packed-git-'),
    );
    const { frame } = await packedPayloads(root);
    await stage(root, join(directory.path, 'guest-root'), frame);
    await mkdir(join(directory.path, 'scratch'));

    const { calls, outcomes, notes } = await runPackedGit(
      join(directory.path, 'guest-root'),
      join(directory.path, 'scratch'),
      ['monterey'],
    );

    expect(calls.map(([, , command]) => command)).not.toContain('install');
    expect(calls.map(([, , command]) => command)).not.toContain('upgrade');
    expect(calls.filter(([program]) => program === 'link')).toEqual([]);
    expect(notes).toContainEqual(
      expect.stringMatching(
        /^Component git failed: No (?:x86_64|arm64)_linux bottle for curl; refusing to build from source$/,
      ),
    );
    expect(outcomes).toEqual({
      git: { status: 'failed', error: 'install failed' },
    });
  });

  it('should ship no guest task hold, and a Sprite adapter that touches only its own task', async () => {
    const root = await packageRoot();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-sprite-adapter-'),
    );
    const { frame, declared } = await packedPayloads(root);
    await stage(root, directory.path, frame);
    const modules = await stagedModules(directory.path);
    const adapter = executableLines(modules.get(SPRITE_ADAPTER)!.source);

    expect(modules.has('guest/guest-task-hold.js')).toBe(false);
    expect(frame.map(({ name }) => name)).not.toContain(
      'guest/guest-task-hold.js',
    );
    expect(declared).toContainEqual({
      module: SPRITE_ADAPTER,
      account: 'agent',
    });
    // the adapter may name the Sprite socket once, to reach its own task, and
    // nothing else the service-control search looks for
    expect(adapter).toContain(SPRITE_TASK_SOCKET);
    expect(SERVICE_CONTROL.test(adapter.replace(SPRITE_TASK_SOCKET, ''))).toBe(
      false,
    );
    // it needs no credential and loads only built-ins
    expect(specifiersOf(modules.get(SPRITE_ADAPTER)!)).toEqual({
      relative: [],
      bare: ['node:http'],
    });
  });

  it('should give the idle governor and its awake command no way to control a service', async () => {
    const root = await packageRoot();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-idle-graph-'),
    );
    const { frame } = await packedPayloads(root);
    await stage(root, directory.path, frame);
    const modules = await stagedModules(directory.path);

    const graph = importGraph(modules, IDLE_ENTRY_MODULES);
    // the host writes the command entry hooks run; it starts Node and nothing else
    const script = await packedAwakeScript(root, directory.path);
    const controlling = [
      ...[...graph].filter((name) =>
        controlsServices(name, modules.get(name)!.source),
      ),
      ...(SERVICE_CONTROL.test(shellExecutableLines(script))
        ? ['bin/open-agent-awake']
        : []),
    ];
    const modes = [...graph].filter(
      (name) => modules.get(name)?.mode !== SHARED_SCRIPT_MODE,
    );

    expect([...graph]).toEqual(
      expect.arrayContaining([
        'guest/idle/governor.js',
        'guest/idle/adapter.js',
        'guest/idle/holders.js',
        'guest/idle/lock.js',
        'guest/idle/state.js',
      ]),
    );
    expect(shellExecutableLines(script)).toContain('guest/idle/awake.js');
    expect(controlling).toEqual([]);
    expect(modes).toEqual([]);
  });

  it('should give the shell idle governor and its awake adapters no way to control a service', async () => {
    const root = await packageRoot();

    const controlling: string[] = [];
    for (const [name, allowed] of [
      [AWAKE_SCRIPT, undefined] as const,
      ...AWAKE_ADAPTER_SCRIPTS,
    ]) {
      const source = await readFile(join(root, 'lib', name), 'utf8');
      const executable = shellExecutableLines(source).replaceAll(
        allowed ?? '',
        '',
      );
      if (SERVICE_CONTROL.test(executable)) {
        controlling.push(name);
      }
    }

    expect(controlling).toEqual([]);
  });

  it.each([
    ['a parent segment', 'drivers/../escaped.js'],
    ['a parent segment above the root', 'guest/../../escaped.js'],
    ['an absolute name', '/etc/open-agent-escaped.js'],
    ['a current-directory segment', 'drivers/./escaped.js'],
  ])('should refuse %s in a staged name', async (_label, name) => {
    const root = await packageRoot();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-stage-name-'),
    );
    const guestRoot = join(directory.path, 'root');
    await mkdir(guestRoot);

    const { exitCode } = await runStage(root, guestRoot, {
      frame: [{ name, contents: 'export {};\n', mode: 0o755 }],
    });

    expect(exitCode).toBe(1);
    expect(await readdir(directory.path)).toEqual(['root']);
    expect(await readdir(guestRoot)).not.toContain('drivers');
  });

  it('should refuse to stage through a symlinked directory', async () => {
    const root = await packageRoot();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-stage-link-'),
    );
    const guestRoot = join(directory.path, 'root');
    const outside = join(directory.path, 'outside');
    await mkdir(guestRoot);
    await mkdir(outside);
    await symlink(outside, join(guestRoot, 'drivers'));

    const { exitCode } = await runStage(root, guestRoot, {
      frame: [
        {
          name: 'drivers/agents/t3/guest/planted.js',
          contents: 'export {};\n',
          mode: 0o755,
        },
      ],
    });

    expect(exitCode).toBe(1);
    expect(await readdir(outside)).toEqual([]);
  });

  it('should refuse to stage when the kernel directory is a symlink', async () => {
    const root = await packageRoot();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-stage-kernel-'),
    );
    const guestRoot = join(directory.path, 'root');
    const moved = join(directory.path, 'elsewhere', 'guest');
    await mkdir(guestRoot);
    await mkdir(moved, { recursive: true });
    await symlink(moved, join(guestRoot, 'guest'));

    const { exitCode } = await runStage(root, guestRoot, {
      frame: [
        { name: 'guest/records.js', contents: 'export {};\n', mode: 0o755 },
      ],
    });

    expect(exitCode).toBe(1);
    expect(await readdir(moved)).toEqual(['guest-transaction.js']);
    expect(await readdir(join(directory.path, 'elsewhere'))).toEqual(['guest']);
  });

  it('should refuse to stage into a directory another account owns', async () => {
    const root = await packageRoot();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-stage-owner-'),
    );
    const guestRoot = join(directory.path, 'root');
    await mkdir(join(guestRoot, 'drivers'), { recursive: true });
    const stranger = (process.getuid?.() ?? 0) + 1;

    const { exitCode } = await runStage(root, guestRoot, {
      frame: [
        {
          name: 'drivers/agents/t3/guest/planted.js',
          contents: 'export {};\n',
          mode: 0o755,
        },
      ],
      owner: stranger,
    });

    expect(exitCode).toBe(1);
    expect(await readdir(join(guestRoot, 'drivers'))).toEqual([]);
  });

  it('should leave every directory of the staged tree readable by other accounts', async () => {
    const root = await packageRoot();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-directories-'),
    );
    const { frame } = await packedPayloads(root);
    await stage(root, directory.path, frame);

    const entries = await readdir(directory.path, {
      recursive: true,
      withFileTypes: true,
    });
    const directories = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const path = join(entry.parentPath, entry.name);

          return {
            name: relative(directory.path, path),
            mode: (await stat(path)).mode & 0o777,
          };
        }),
    );

    expect(directories.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['guest', 'drivers', 'drivers/agents/t3/guest']),
    );
    expect(
      directories.filter(({ mode }) => mode !== SHARED_DIRECTORY_MODE),
    ).toEqual([]);
  });

  it('should ship no primitive that hands a guest file to another account', async () => {
    const root = await packageRoot();
    const lib = join(root, 'lib');
    const files = (await readdir(lib, { recursive: true })).filter((file) =>
      file.endsWith('.js'),
    );
    const sources = await Promise.all(
      files.map(async (file) => ({
        file,
        source: await readFile(join(lib, file), 'utf8'),
      })),
    );

    const chowning = sources
      .filter(({ source }) => /\bchown\b|\blchown\b/.test(source))
      .map(({ file }) => file);

    expect(chowning).toEqual([]);
  });

  it('should refuse an ownership transfer request in the packed worker', async () => {
    const root = await packageRoot();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-chown-'),
    );
    const target = join(directory.path, 'harness-catalog.js');
    await writeFile(target, 'export {};\n', { mode: 0o755 });
    const descriptor = openSync(join(directory.path, '.lock'), 'w');
    const worker = spawn(
      execPath,
      [join(root, 'lib/guest/guest-transaction.js'), '0'],
      {
        stdio: [
          'pipe',
          'pipe',
          'inherit',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          descriptor,
        ],
      },
    );
    closeSync(descriptor);
    const closed = once(worker, 'close');
    let output = '';
    worker.stdout!.setEncoding('utf8');
    worker.stdout!.on('data', (chunk: string) => {
      output += chunk;
    });

    worker.stdin!.end(
      `${JSON.stringify({ type: 'chown', id: 1, path: target, user: 'agent' })}\n`,
    );
    await closed;
    const frames = output
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { type: string }).type);

    expect(frames).not.toContain('accepted');
    expect(frames.at(-1)).toBe('released');
    expect((await stat(target)).uid).toBe(process.getuid?.() ?? 0);
  });
});

describe('packed CLIProxyAPI hub probe', () => {
  /**
   * runs the packed probe against a record path
   * @param record record path the host passes
   * @returns the probe's single JSON result
   */
  async function probe(record: string): Promise<unknown> {
    const root = await packageRoot();
    const { stdout } = await execa(execPath, [
      join(root, 'lib/drivers/shared/cliproxyapi/guest/hub-probe.js'),
      record,
    ]);

    return JSON.parse(stdout);
  }

  it('should report a missing record as an unreachable gateway', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-hub-probe-'),
    );

    const result = await probe(join(directory.path, 'cliproxyapi.json'));

    expect(result).toEqual({
      reachable: false,
      reason: 'gateway record missing',
    });
  });

  it('should report a malformed record as an unreachable gateway', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-hub-probe-'),
    );
    const record = join(directory.path, 'cliproxyapi.json');
    await writeFile(record, JSON.stringify({ models: 42 }));

    const result = await probe(record);

    expect(result).toEqual({
      reachable: false,
      reason: 'gateway record malformed',
    });
  });

  it('should ask the recorded gateway for its model catalogue with the client key', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-hub-probe-'),
    );
    const requests: Array<{ url?: string; authorization?: string }> = [];
    const server = createServer((request, response) => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[]}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const record = join(directory.path, 'cliproxyapi.json');
    await writeFile(
      record,
      JSON.stringify({
        models: `http://127.0.0.1:${port}/v1/models`,
        apiKey: 'probe-client-key',
      }),
    );

    try {
      const result = await probe(record);

      expect(result).toEqual({ reachable: true, status: 200 });
      expect(requests).toEqual([
        { url: '/v1/models', authorization: 'Bearer probe-client-key' },
      ]);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
