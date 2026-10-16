import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { packageRoot } from '../fixtures/packed-guest';

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
// the shell idle governor, its awake command, and the provider adapters it runs
const AWAKE_SCRIPT = 'governor/awake.sh';
// each with the one line it may have that looks like service control: the
// Sprite adapter's socket, which it uses for its own task alone
const AWAKE_ADAPTER_SCRIPTS: ReadonlyMap<string, string | undefined> = new Map([
  ['drivers/providers/fly-machine/awake.sh', undefined],
  ['drivers/providers/sprite/awake.sh', 'OA_SPRITE_SOCKET=/.sprite/api.sock'],
]);
// the cron gate runs as root every hour and runs the updater once an update
// is due
const UPDATE_GATE_SCRIPT = 'maintenance/update-gate.sh';
// the shell updater and every library the gate sources for it
const UPDATER_SCRIPTS = [
  UPDATE_GATE_SCRIPT,
  'maintenance/updater.sh',
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

/**
 * lists every guest program the packed package ships
 * @param root packed package root
 * @returns paths relative to `guest`
 */
async function shippedPrograms(root: string): Promise<string[]> {
  return (await readdir(join(root, 'guest'), { recursive: true }))
    .filter((path) => path.endsWith('.sh'))
    .sort();
}

describe('packed guest programs', () => {
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
      "const services = await readFile('environment.json');",
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

  it('should give the update gate, the updater and every library it sources no way to control or mask a service', async () => {
    const root = await packageRoot();
    // the cron gate and the shell updater it runs, with every library it
    // sources: none of them may control a service, and none masks one
    const updater = new Map(
      await Promise.all(
        [...UPDATER_SCRIPTS, FAMILY_LIBRARY].map(
          async (name) =>
            [
              name,
              shellExecutableLines(
                await readFile(join(root, 'guest', name), 'utf8'),
              ),
            ] as const,
        ),
      ),
    );
    const family = updater.get(FAMILY_LIBRARY)!;
    updater.set(FAMILY_LIBRARY, family.replace(MASK_FUNCTION, ''));
    const controlling = [...updater]
      .filter(([, source]) => SERVICE_CONTROL.test(source))
      .map(([name]) => name);
    const masking = UPDATER_SCRIPTS.filter((name) =>
      updater.get(name)!.includes('oa_mask_service'),
    );

    expect(family).toMatch(MASK_FUNCTION);
    expect(updater.get(UPDATE_GATE_SCRIPT)).toContain('oa_update_run');
    expect(masking).toEqual([]);
    expect(controlling).toEqual([]);
  });

  it('should ship guest programs that build nothing from source', async () => {
    const root = await packageRoot();
    const programs = await Promise.all(
      (await shippedPrograms(root)).map(async (name) => ({
        name,
        source: shellExecutableLines(
          await readFile(join(root, 'guest', name), 'utf8'),
        ),
      })),
    );

    expect(programs.length).toBeGreaterThan(0);
    expect(
      programs
        .filter(({ source }) => SOURCE_BUILD.test(source))
        .map(({ name }) => name),
    ).toEqual([]);
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

  it('should give the shell idle governor and its awake adapters no way to control a service', async () => {
    const root = await packageRoot();

    const controlling: string[] = [];
    for (const [name, allowed] of [
      [AWAKE_SCRIPT, undefined] as const,
      ...AWAKE_ADAPTER_SCRIPTS,
    ]) {
      const source = await readFile(join(root, 'guest', name), 'utf8');
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
});
