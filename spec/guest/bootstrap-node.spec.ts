import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtempDisposable,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(
  new URL('../../src/guest/bootstrap-node.sh', import.meta.url),
);
const SUFFIX = /\.[A-Za-z0-9]{6}$/;

// the stand-ins for the guest's tools run on the machine that tests the script:
// Node scripts replace the commands whose flags differ between GNU and BSD
const CURL = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const url = args.find((arg) => arg.startsWith('https://'));
fs.appendFileSync(path.join(process.env.SHIM_STATE, 'requests.log'), url + '\\n');
if (process.env.SHIM_HOLD && url.endsWith('.tar.xz')) {
  const release = path.join(process.env.SHIM_STATE, 'go');
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(release) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}
const file = path.join(process.env.SHIM_FIXTURES, url.replace('https://nodejs.org/dist/', ''));
if (!fs.existsSync(file)) process.exit(22);
const data = fs.readFileSync(file);
const out = args.includes('-o') ? args[args.indexOf('-o') + 1] : undefined;
if (out) fs.writeFileSync(out, data); else process.stdout.write(data);
`;
const SHA256SUM = `
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const lines = fs.readFileSync(0, 'utf8').split('\\n').filter(Boolean);
if (lines.length === 0) process.exit(1);
let ok = true;
for (const line of lines) {
  const [hash, name] = line.split(/\\s+/);
  const actual = createHash('sha256').update(fs.readFileSync(name)).digest('hex');
  ok = ok && actual === hash;
}
process.exit(ok ? 0 : 1);
`;
// GNU mv: without -T a destination that is, or links to, a directory receives the source inside it
const MV = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const noTarget = args.includes('-T');
const [from, requested] = args.filter((arg) => !arg.startsWith('-'));
let to = requested;
if (!noTarget && fs.existsSync(requested) && fs.statSync(requested).isDirectory()) {
  to = path.join(requested, path.basename(from));
}
fs.renameSync(from, to);
`;
const INSTALL = `
const fs = require('node:fs');
const args = process.argv.slice(2);
let mode = '755';
let directories = false;
const operands = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '-m') { mode = args[index + 1]; index += 1; }
  else if (args[index] === '-d') { directories = true; }
  else operands.push(args[index]);
}
if (directories) {
  for (const directory of operands) fs.mkdirSync(directory, { recursive: true });
} else {
  const [from, to] = operands;
  if (from === '/dev/null') fs.writeFileSync(to, ''); else fs.copyFileSync(from, to);
  fs.chmodSync(to, parseInt(mode, 8));
}
`;

/** the directories one run of the script works in */
interface Sandbox {
  /** the guest root */
  root: string;
  /** stands in for /usr/local/bin */
  bin: string;
  /** what the release host serves */
  fixtures: string;
  /** where the stand-ins record what they were asked */
  state: string;
  /** the script with the guest's fixed paths pointed into the sandbox */
  script: string;
  /** the stand-in commands */
  shims: string;
  /** stands in for /proc, one directory per running process */
  proc: string;
}

/** what a run of the script left behind */
interface Result {
  /** exit status of the script */
  exitCode: number;
  /** outcomes the script recorded, when it recorded any */
  outcomes: unknown;
  /** URLs the script asked the release host for */
  requests: string[];
}

/**
 * writes an executable
 * @param path where the file goes
 * @param source program text
 */
async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

/**
 * builds a sandbox where the script cannot touch the machine it runs on
 * @param base empty directory owned by the test
 * @returns the directories and patched script of one run
 */
async function sandboxIn(base: string): Promise<Sandbox> {
  const sandbox: Sandbox = {
    root: join(base, 'root'),
    bin: join(base, 'bin'),
    fixtures: join(base, 'fixtures'),
    state: join(base, 'state'),
    script: join(base, 'bootstrap-node.sh'),
    shims: join(base, 'shims'),
    proc: join(base, 'proc'),
  };
  for (const directory of [
    sandbox.root,
    sandbox.bin,
    sandbox.fixtures,
    sandbox.state,
    sandbox.shims,
    sandbox.proc,
  ]) {
    await mkdir(directory, { recursive: true });
  }
  const node = `#!${process.execPath}\n`;
  await writeExecutable(join(sandbox.shims, 'curl'), node + CURL);
  await writeExecutable(join(sandbox.shims, 'sha256sum'), node + SHA256SUM);
  await writeExecutable(join(sandbox.shims, 'mv'), node + MV);
  await writeExecutable(join(sandbox.shims, 'install'), node + INSTALL);
  for (const name of ['apt-get', 'getent', 'useradd']) {
    await writeExecutable(join(sandbox.shims, name), '#!/bin/sh\nexit 0\n');
  }
  await writeExecutable(
    join(sandbox.shims, 'uname'),
    '#!/bin/sh\necho x86_64\n',
  );
  await writeFile(join(base, 'os-release'), 'ID=debian\n');
  const source = await readFile(SCRIPT, 'utf8');
  await writeFile(
    sandbox.script,
    source
      .replace(
        'export PATH=/usr/sbin:/usr/bin:/sbin:/bin',
        `export PATH="${sandbox.shims}:${process.env.PATH}"`,
      )
      .replaceAll('/usr/local/bin', sandbox.bin)
      .replaceAll('/proc/', `${sandbox.proc}/`)
      .replaceAll('/etc/os-release', join(base, 'os-release')),
  );

  return sandbox;
}

/**
 * lays out a Node tree whose binary reports a version
 * @param directory where the tree goes
 * @param reports what `node --version` prints
 */
async function writeTree(directory: string, reports: string): Promise<void> {
  await mkdir(join(directory, 'bin'), { recursive: true });
  for (const name of ['node', 'npm', 'npx']) {
    await writeExecutable(
      join(directory, 'bin', name),
      `#!/bin/sh\necho ${name === 'node' ? reports : name}\n`,
    );
  }
}

/**
 * publishes a Node release on the stand-in release host
 * @param sandbox where the host serves from
 * @param version bare dotted version of the release
 * @param options how the release misbehaves
 * @param options.reports what the archive's binary prints, when not its own version
 * @param options.corrupt whether the published checksum is wrong
 */
async function publish(
  sandbox: Sandbox,
  version: string,
  options: { reports?: string; corrupt?: boolean } = {},
): Promise<void> {
  const release = join(sandbox.fixtures, `v${version}`);
  const name = `node-v${version}-linux-x64`;
  const staged = join(sandbox.state, 'staged');
  await mkdir(release, { recursive: true });
  await writeTree(join(staged, name), options.reports ?? `v${version}`);
  await run('tar', [
    '-cJf',
    join(release, `${name}.tar.xz`),
    '-C',
    staged,
    name,
  ]);
  const hash = options.corrupt
    ? '0'.repeat(64)
    : createHash('sha256')
        .update(await readFile(join(release, `${name}.tar.xz`)))
        .digest('hex');
  await writeFile(
    join(release, 'SHASUMS256.txt'),
    `${hash}  ${name}.tar.xz\n${'1'.repeat(64)}  ${name}.pkg\n`,
  );
}

/**
 * publishes the release index, newest first, behind an unstable build
 * @param sandbox where the host serves from
 * @param versions stable versions, newest first
 */
async function publishIndex(
  sandbox: Sandbox,
  versions: string[],
): Promise<void> {
  await writeFile(
    join(sandbox.fixtures, 'index.json'),
    JSON.stringify(
      ['v99.0.0-nightly', ...versions.map((version) => `v${version}`)].map(
        (version) => ({ version }),
      ),
    ),
  );
}

/**
 * the environment the stand-in commands read
 * @param sandbox where the script runs
 * @param extra further variables for the stand-ins
 * @returns the environment of the script
 */
function environmentOf(
  sandbox: Sandbox,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SHIM_FIXTURES: sandbox.fixtures,
    SHIM_STATE: sandbox.state,
    ...extra,
  };
}

/**
 * runs the script in a sandbox
 * @param sandbox where it runs
 * @returns what it left behind
 */
async function bootstrap(sandbox: Sandbox): Promise<Result> {
  const exitCode = await run('/bin/sh', [sandbox.script, sandbox.root], {
    env: environmentOf(sandbox),
  }).then(
    () => 0,
    (error: { code: number }) => error.code,
  );

  return collect(sandbox, exitCode);
}

/**
 * reads what a finished run left behind
 * @param sandbox where it ran
 * @param exitCode exit status of the script
 * @returns the run's result
 */
async function collect(sandbox: Sandbox, exitCode: number): Promise<Result> {
  const outcomes = await readFile(
    join(sandbox.root, 'install-outcomes.json'),
    'utf8',
  ).then(
    (text): unknown => JSON.parse(text),
    () => undefined,
  );
  const requests = await readFile(join(sandbox.state, 'requests.log'), 'utf8')
    .then((text) => text.split('\n').filter(Boolean))
    .catch(() => []);

  return { exitCode, outcomes, requests };
}

/**
 * lists the Node trees in the guest root, without the random part of their names
 * @param sandbox where the script ran
 * @returns sorted tree names
 */
async function trees(sandbox: Sandbox): Promise<string[]> {
  return (await readdir(sandbox.root))
    .filter((name) => name.startsWith('node-'))
    .map((name) => name.replace(SUFFIX, ''))
    .sort();
}

describe('script:bootstrap-node', () => {
  it('should install the latest stable Node into a versioned tree and link it', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-bootstrap-node-'),
    );
    const sandbox = await sandboxIn(directory.path);
    await publishIndex(sandbox, ['22.1.0', '22.0.0']);
    await publish(sandbox, '22.1.0');

    const result = await bootstrap(sandbox);

    expect(result).toEqual({
      exitCode: 0,
      outcomes: { 'guest-node': { status: 'installed', version: '22.1.0' } },
      requests: [
        'https://nodejs.org/dist/index.json',
        'https://nodejs.org/dist/v22.1.0/node-v22.1.0-linux-x64.tar.xz',
        'https://nodejs.org/dist/v22.1.0/SHASUMS256.txt',
      ],
    });
    expect(await readlink(join(sandbox.root, 'node'))).toMatch(
      /^node-v22\.1\.0\.[A-Za-z0-9]{6}$/,
    );
    expect(
      (await run(join(sandbox.root, 'node', 'bin', 'node'))).stdout.trim(),
    ).toBe('v22.1.0');
    // the user-facing Node is Homebrew's, so nothing of the private one is linked
    expect(await readdir(sandbox.bin)).toEqual([]);
  });

  it('should leave Node untouched and download nothing when it already reports the latest version', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-bootstrap-skip-'),
    );
    const sandbox = await sandboxIn(directory.path);
    await publishIndex(sandbox, ['22.1.0']);
    await publish(sandbox, '22.1.0');
    await bootstrap(sandbox);
    await rm(join(sandbox.state, 'requests.log'));
    const tree = await readlink(join(sandbox.root, 'node'));

    const result = await bootstrap(sandbox);

    expect(result).toEqual({
      exitCode: 0,
      outcomes: { 'guest-node': { status: 'skipped', version: '22.1.0' } },
      requests: ['https://nodejs.org/dist/index.json'],
    });
    expect(await readlink(join(sandbox.root, 'node'))).toBe(tree);
  });

  it('should link nothing into the tool directory when Node is current', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-bootstrap-nolink-'),
    );
    const sandbox = await sandboxIn(directory.path);
    await publishIndex(sandbox, ['22.1.0']);
    await writeTree(join(sandbox.root, 'node-v22.1.0.AbCdEf'), 'v22.1.0');
    await symlink('node-v22.1.0.AbCdEf', join(sandbox.root, 'node'));

    const result = await bootstrap(sandbox);

    expect(result.outcomes).toEqual({
      'guest-node': { status: 'skipped', version: '22.1.0' },
    });
    expect(await readdir(sandbox.bin)).toEqual([]);
  });

  it('should swap in a newer Node beside the running one and keep only the tree it replaced', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-bootstrap-upgrade-'),
    );
    const sandbox = await sandboxIn(directory.path);
    await publishIndex(sandbox, ['22.1.0']);
    await publish(sandbox, '22.1.0');
    await writeTree(join(sandbox.root, 'node-v21.0.0.ZzZzZz'), 'v21.0.0');
    await writeTree(join(sandbox.root, 'node-v22.0.0.AbCdEf'), 'v22.0.0');
    await symlink('node-v22.0.0.AbCdEf', join(sandbox.root, 'node'));

    const result = await bootstrap(sandbox);

    expect(result.outcomes).toEqual({
      'guest-node': { status: 'installed', version: '22.1.0' },
    });
    expect(await trees(sandbox)).toEqual(['node-v22.0.0', 'node-v22.1.0']);
    expect(
      (
        await run(join(sandbox.root, 'node-v22.0.0.AbCdEf', 'bin', 'node'))
      ).stdout.trim(),
    ).toBe('v22.0.0');
    expect(
      (await run(join(sandbox.root, 'node', 'bin', 'node'))).stdout.trim(),
    ).toBe('v22.1.0');
  });

  it('should point the link at the new tree and leave the tool directory alone', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-bootstrap-relink-over-'),
    );
    const sandbox = await sandboxIn(directory.path);
    await publishIndex(sandbox, ['22.1.0']);
    await publish(sandbox, '22.1.0');
    await writeTree(join(sandbox.root, 'node-v22.0.0.AbCdEf'), 'v22.0.0');
    await symlink('node-v22.0.0.AbCdEf', join(sandbox.root, 'node'));
    await symlink('/elsewhere/node', join(sandbox.bin, 'node'));

    await bootstrap(sandbox);

    // a move without -T would put the new link inside the old tree instead
    expect(await readlink(join(sandbox.root, 'node'))).toMatch(
      /^node-v22\.1\.0\.[A-Za-z0-9]{6}$/,
    );
    expect(
      (await readdir(join(sandbox.root, 'node-v22.0.0.AbCdEf'))).sort(),
    ).toEqual(['bin']);
    expect(await readlink(join(sandbox.bin, 'node'))).toBe('/elsewhere/node');
  });

  it('should keep a tree a process still runs from while pruning the others', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-bootstrap-busy-'),
    );
    const sandbox = await sandboxIn(directory.path);
    await publishIndex(sandbox, ['22.1.0']);
    await publish(sandbox, '22.1.0');
    await writeTree(join(sandbox.root, 'node-v20.0.0.Unused'), 'v20.0.0');
    await writeTree(join(sandbox.root, 'node-v21.0.0.Served'), 'v21.0.0');
    await writeTree(join(sandbox.root, 'node-v22.0.0.AbCdEf'), 'v22.0.0');
    await symlink('node-v22.0.0.AbCdEf', join(sandbox.root, 'node'));
    await mkdir(join(sandbox.proc, '4242'));
    await symlink(
      join(sandbox.root, 'node-v21.0.0.Served', 'bin', 'node'),
      join(sandbox.proc, '4242', 'exe'),
    );

    const result = await bootstrap(sandbox);

    expect(result.outcomes).toEqual({
      'guest-node': { status: 'installed', version: '22.1.0' },
    });
    expect(await trees(sandbox)).toEqual([
      'node-v21.0.0',
      'node-v22.0.0',
      'node-v22.1.0',
    ]);
  });

  it('should clear staging and link names a killed run left, and trees nothing links to', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-bootstrap-leftovers-'),
    );
    const sandbox = await sandboxIn(directory.path);
    await publishIndex(sandbox, ['22.1.0']);
    await writeTree(join(sandbox.root, 'node-v22.1.0.AbCdEf'), 'v22.1.0');
    await symlink('node-v22.1.0.AbCdEf', join(sandbox.root, 'node'));
    await writeTree(join(sandbox.root, 'node-v22.1.0.Halfed'), 'v22.1.0');
    await symlink(
      'node-v22.1.0.Halfed',
      join(sandbox.root, '.node-link.Qwerty'),
    );

    const result = await bootstrap(sandbox);

    expect(result.outcomes).toEqual({
      'guest-node': { status: 'skipped', version: '22.1.0' },
    });
    expect(
      (await readdir(sandbox.root)).filter(
        (name) => !name.startsWith('install'),
      ),
    ).toEqual(['node', expect.stringMatching(/^node-v22\.1\.0\./)]);
    expect(await readlink(join(sandbox.root, 'node'))).toBe(
      'node-v22.1.0.AbCdEf',
    );
  });

  it('should install again when the current Node reports the latest version but its npm does not run', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-bootstrap-npm-'),
    );
    const sandbox = await sandboxIn(directory.path);
    await publishIndex(sandbox, ['22.1.0']);
    await publish(sandbox, '22.1.0');
    const tree = join(sandbox.root, 'node-v22.1.0.Broken');
    await writeTree(tree, 'v22.1.0');
    await writeExecutable(join(tree, 'bin', 'npm'), '#!/bin/sh\nexit 1\n');
    await symlink('node-v22.1.0.Broken', join(sandbox.root, 'node'));

    const result = await bootstrap(sandbox);

    expect(result.outcomes).toEqual({
      'guest-node': { status: 'installed', version: '22.1.0' },
    });
    expect(result.requests).toContain(
      'https://nodejs.org/dist/v22.1.0/node-v22.1.0-linux-x64.tar.xz',
    );
    expect(await readlink(join(sandbox.root, 'node'))).not.toBe(
      'node-v22.1.0.Broken',
    );
    expect(
      (await run(join(sandbox.root, 'node', 'bin', 'npm'))).stdout.trim(),
    ).toBe('npm');
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'should record a failed outcome and leave the live Node alone when %s ends the run',
    async (signal) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-bootstrap-signal-'),
      );
      const sandbox = await sandboxIn(directory.path);
      await publishIndex(sandbox, ['22.1.0']);
      await publish(sandbox, '22.1.0');
      await writeTree(join(sandbox.root, 'node-v22.0.0.AbCdEf'), 'v22.0.0');
      await symlink('node-v22.0.0.AbCdEf', join(sandbox.root, 'node'));
      await writeFile(
        join(sandbox.root, 'install-outcomes.json'),
        JSON.stringify({
          'guest-node': { status: 'skipped', version: '1.0.0' },
        }),
      );
      const child = spawn('/bin/sh', [sandbox.script, sandbox.root], {
        env: environmentOf(sandbox, { SHIM_HOLD: '1' }),
        stdio: 'ignore',
      });
      const exited = new Promise<number | null>((resolve) => {
        child.once('close', (code) => {
          resolve(code);
        });
      });
      // the download is the step the run is held in
      for (
        let waited = 0;
        waited < 10_000 &&
        !(await readFile(join(sandbox.state, 'requests.log'), 'utf8')
          .then((text) => text.includes('.tar.xz'))
          .catch(() => false));
        waited += 20
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      child.kill(signal);
      await writeFile(join(sandbox.state, 'go'), '');
      const exitCode = await exited;
      const result = await collect(sandbox, exitCode ?? -1);

      expect(result.exitCode).toBe(signal === 'SIGTERM' ? 143 : 130);
      expect(result.outcomes).toEqual({
        'guest-node': { status: 'failed', error: 'install failed' },
      });
      expect(await readlink(join(sandbox.root, 'node'))).toBe(
        'node-v22.0.0.AbCdEf',
      );
      expect(await trees(sandbox)).toEqual(['node-v22.0.0']);
    },
  );

  it.each([
    ['a checksum that does not match', { corrupt: true }],
    ['a binary that reports another version', { reports: 'v22.0.9' }],
  ])(
    'should fail and leave the live Node and the tree list alone for %s',
    async (_label, options) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-bootstrap-refuse-'),
      );
      const sandbox = await sandboxIn(directory.path);
      await publishIndex(sandbox, ['22.1.0']);
      await publish(sandbox, '22.1.0', options);
      await writeTree(join(sandbox.root, 'node-v22.0.0.AbCdEf'), 'v22.0.0');
      await symlink('node-v22.0.0.AbCdEf', join(sandbox.root, 'node'));

      const result = await bootstrap(sandbox);

      expect(result.exitCode).not.toBe(0);
      expect(result.outcomes).toEqual({
        'guest-node': { status: 'failed', error: 'install failed' },
      });
      expect(await readlink(join(sandbox.root, 'node'))).toBe(
        'node-v22.0.0.AbCdEf',
      );
      expect(await trees(sandbox)).toEqual(['node-v22.0.0']);
    },
  );

  it('should fail the component and leave Node alone when the release index cannot be read', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-bootstrap-offline-'),
    );
    const sandbox = await sandboxIn(directory.path);
    await writeTree(join(sandbox.root, 'node-v22.0.0.AbCdEf'), 'v22.0.0');
    await symlink('node-v22.0.0.AbCdEf', join(sandbox.root, 'node'));

    const result = await bootstrap(sandbox);

    expect(result.exitCode).not.toBe(0);
    expect(result.outcomes).toEqual({
      'guest-node': {
        status: 'failed',
        error: 'latest version could not be resolved',
      },
    });
    expect(await readlink(join(sandbox.root, 'node'))).toBe(
      'node-v22.0.0.AbCdEf',
    );
  });

  it('should fail the component when the index lists no stable release', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-bootstrap-unstable-'),
    );
    const sandbox = await sandboxIn(directory.path);
    await publishIndex(sandbox, []);

    const result = await bootstrap(sandbox);

    expect(result.exitCode).not.toBe(0);
    expect(result.outcomes).toEqual({
      'guest-node': {
        status: 'failed',
        error: 'latest version could not be resolved',
      },
    });
  });

  it('should not read an outcomes file an earlier run left', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-bootstrap-stale-'),
    );
    const sandbox = await sandboxIn(directory.path);
    await writeFile(
      join(sandbox.root, 'install-outcomes.json'),
      JSON.stringify({ 'guest-node': { status: 'skipped', version: '1.0.0' } }),
    );
    await publishIndex(sandbox, []);

    const result = await bootstrap(sandbox);

    expect(result.outcomes).toEqual({
      'guest-node': {
        status: 'failed',
        error: 'latest version could not be resolved',
      },
    });
  });
});
