import { execFile, spawn } from 'node:child_process';
import {
  mkdir,
  mkdtempDisposable,
  readFile,
  readdir,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  aptSection,
  linkSection,
} from '#drivers/providers/fly-machine/guest/boot-restore';
import {
  bootScript,
  handoverSection,
  stopSection,
} from '#drivers/providers/fly-machine/guest/boot-script';
import { GUEST_ROOT } from '#guest/guest-root';
import {
  HOMEBREW,
  TOOL_LINK_DIRECTORY,
  TOOL_LINK_RECORD,
} from '#guest/homebrew';
import { SUPERVISOR_COMMAND } from '#guest/supervisor/protocol';

const run = promisify(execFile);

/** the guest environment Fly gives every process */
const MACHINE_ENV = {
  FLY_APP_NAME: 'oa-probe',
  FLY_MACHINE_ID: '148e21d9a30d08',
};

/** a fake Machines API on a Unix socket */
interface FakeApi {
  /** the socket path */
  socket: string;
  /** every `METHOD path` the API received */
  received: string[];
  /** resolves once a request arrived */
  arrived: Promise<void>;
}

/**
 * serves the Machines API socket, answering every request with one status
 * @param directory where the socket lives
 * @param status what every request is answered with
 * @param work what to do with the API while it runs
 * @returns whatever work returns
 */
async function withApi<T>(
  directory: string,
  status: number,
  work: (api: FakeApi) => Promise<T>,
): Promise<T> {
  const socket = join(directory, 'api.sock');
  const received: string[] = [];
  let arrive: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const server = createServer((request, response) => {
    received.push(`${request.method} ${request.url}`);
    response.writeHead(status);
    response.end();
    arrive();
  });
  await new Promise<void>((resolve) => {
    server.listen(socket, resolve);
  });
  try {
    return await work({ socket, received, arrived });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('fn:bootScript', () => {
  it('should render POSIX shell that parses', async () => {
    await expect(
      run('/bin/sh', ['-n', '-c', bootScript()]),
    ).resolves.toMatchObject({ stderr: '' });
  });

  it('should hand over to the supervisor entry and never update or build packages', () => {
    const script = bootScript();

    expect({
      handsOver: script.includes(`supervisor=${SUPERVISOR_COMMAND}`),
      updates: /apt-get update|build-essential|\bgcc\b/u.test(script),
    }).toEqual({ handsOver: true, updates: false });
  });
});

describe('fn:aptSection', () => {
  it('should reinstall the compiler and the network diagnostics a boot recorded, and no cron', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-boot-apt-'),
    );
    const record = join(directory.path, 'packages');
    await writeFile(
      record,
      [
        'gcc',
        'libc6-dev',
        'libstdc++6',
        'iputils-ping',
        'telnet',
        'dnsutils',
        'netcat-openbsd',
        'traceroute',
        'iproute2',
        'wget',
        'cron',
        'cron-daemon-common',
        '',
      ].join('\n'),
    );

    const shims = join(directory.path, 'shims');
    await mkdir(shims);
    await writeFile(
      join(shims, 'apt-get'),
      '#!/bin/sh\nprintf "%s\\n" "$*"\n',
      { mode: 0o755 },
    );

    const { stdout } = await run(
      '/bin/sh',
      ['-c', [`record=${record}`, aptSection(), 'install_packages'].join('\n')],
      { env: { ...process.env, PATH: `${shims}:${process.env.PATH}` } },
    );

    expect(stdout).toContain(
      'Installing gcc libc6-dev libstdc++6 iputils-ping telnet dnsutils netcat-openbsd traceroute iproute2 wget',
    );
    expect(stdout).not.toMatch(/\bcron\b/u);
  });
});

describe('fn:linkSection', () => {
  /** the section with its absolute paths pointed into a scratch directory, and the ownership checks answered from the test */
  interface Restore {
    /** the directory standing for /usr/local/bin */
    bin: string;
    /** the record's path */
    record: string;
    /** a scratch directory the targets live in */
    targets: string;
    /** runs restore_links; resolves with its stdout, or the failure, which holds stdout and the exit code */
    restore: (
      owner?: number,
      mode?: string,
    ) => Promise<{ stdout: string; code?: number }>;
  }

  /**
   * prepares a scratch machine for the section
   * @param directory scratch directory
   * @returns the scratch paths and the runner
   */
  async function machine(directory: string): Promise<Restore> {
    const bin = join(directory, 'bin');
    const targets = join(directory, 'targets');
    const record = join(directory, 'links');
    await mkdir(bin);
    await mkdir(targets);
    const section = linkSection()
      .replaceAll(TOOL_LINK_RECORD, record)
      .replaceAll(TOOL_LINK_DIRECTORY, bin);

    return {
      bin,
      record,
      targets,
      restore: async (owner = 0, mode = '644') =>
        run('/bin/sh', [
          '-c',
          [
            'link() { ln -sfn "$1" "$2"; }',
            // the guest's stat reads the record's owner and mode; the proof answers for it
            `stat() { case "$2" in %u) echo ${owner} ;; %a) echo ${mode} ;; esac; }`,
            section,
            'restore_links',
          ].join('\n'),
        ]).catch((error: { stdout: string; code: number }) => error),
    };
  }

  it('should restore each recorded link, whichever tool made it, and nothing else', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-boot-links-'),
    );
    const { bin, record, targets, restore } = await machine(directory.path);
    for (const name of ['git', 'python3', 'tailscale']) {
      await writeFile(join(targets, name), '');
    }
    await writeFile(
      record,
      [
        ['git', 'git'],
        ['python3', 'python3'],
        ['tailscale', 'tailscale'],
      ]
        .map(([name, target]) => `${bin}/${name}\t${targets}/${target}\n`)
        .join(''),
    );
    await writeFile(join(bin, 'stale'), '');

    const { stdout, code } = await restore();

    expect(code).toBeUndefined();
    expect(stdout).not.toContain('Skipping');
    expect((await readdir(bin)).sort()).toEqual(
      ['git', 'python3', 'stale', 'tailscale'].sort(),
    );
    expect(await readlink(join(bin, 'tailscale'))).toBe(
      join(targets, 'tailscale'),
    );
    expect(await readlink(join(bin, 'git'))).toBe(join(targets, 'git'));
  });

  it('should replace a link that points elsewhere', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-boot-links-'),
    );
    const { bin, record, targets, restore } = await machine(directory.path);
    await writeFile(join(targets, 'new'), '');
    await symlink('/nowhere', join(bin, 'uv'));
    await writeFile(record, `${bin}/uv\t${targets}/new\n`);

    await restore();

    expect(await readlink(join(bin, 'uv'))).toBe(join(targets, 'new'));
  });

  it('should skip a line outside /usr/local/bin, below it, with an unsafe name, a relative target or a missing target, and still restore the others', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-boot-links-'),
    );
    const { bin, record, targets, restore } = await machine(directory.path);
    await writeFile(join(targets, 'real'), '');
    await writeFile(
      record,
      [
        `${directory.path}/elsewhere\t${targets}/real`,
        `${bin}/sub/nested\t${targets}/real`,
        `${bin}/.hidden\t${targets}/real`,
        `${bin}/has space\t${targets}/real`,
        `${bin}/..\t${targets}/real`,
        `${bin}/relative\ttargets/real`,
        `${bin}/missing\t${targets}/absent`,
        `${bin}/no-target`,
        `${bin}/good\t${targets}/real`,
        '',
      ].join('\n'),
    );

    const { stdout, code } = await restore();

    expect(code).toBeUndefined();
    expect(await readdir(bin)).toEqual(['good']);
    expect(stdout.match(/Skipping/gu)).toHaveLength(8);
    expect(stdout).toContain('is not an absolute path');
    expect(stdout).toContain('does not exist');
  });

  it('should restore a last line that has no line break', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-boot-links-'),
    );
    const { bin, record, targets, restore } = await machine(directory.path);
    await writeFile(join(targets, 'real'), '');
    await writeFile(record, `${bin}/last\t${targets}/real`);

    await restore();

    expect(await readdir(bin)).toEqual(['last']);
  });

  it('should have nothing to restore before the installer recorded a link', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-boot-links-'),
    );
    const { bin, restore } = await machine(directory.path);

    const { stdout, code } = await restore();

    expect(code).toBeUndefined();
    expect(stdout).toBe('No links are recorded yet\n');
    expect(await readdir(bin)).toEqual([]);
  });

  it.each([
    ['owned by another account', 1000, '644'],
    ['writable by its group', 0, '664'],
    ['writable by every account', 0, '666'],
  ])('should refuse a record %s', async (_label, owner, mode) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-boot-links-'),
    );
    const { bin, record, targets, restore } = await machine(directory.path);
    await writeFile(join(targets, 'real'), '');
    await writeFile(record, `${bin}/git\t${targets}/real\n`);

    const { stdout, code } = await restore(owner, mode);

    expect(code).toBe(1);
    expect(stdout).toContain('Refusing');
    expect(await readdir(bin)).toEqual([]);
  });

  it('should refuse a record that is a link', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-boot-links-'),
    );
    const { bin, record, targets, restore } = await machine(directory.path);
    await writeFile(join(targets, 'real'), '');
    await writeFile(join(targets, 'other'), `${bin}/git\t${targets}/real\n`);
    await symlink(join(targets, 'other'), record);

    const { stdout, code } = await restore();

    expect(code).toBe(1);
    expect(stdout).toContain('Refusing');
    expect(await readdir(bin)).toEqual([]);
  });

  it('should carry no list of tools of its own', () => {
    const section = linkSection();

    expect(section).not.toContain('link_keg');
    expect(section).not.toContain(`${GUEST_ROOT}/tools`);
    expect(section).not.toContain(HOMEBREW.prefix);
  });
});

describe('fn:handoverSection', () => {
  it('should start the supervisor after an optional step failed, as long as no critical step halted the boot', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-boot-'),
    );
    const entry = join(directory.path, 'supervisor');
    await writeFile(entry, '#!/bin/sh\necho supervised\n', { mode: 0o755 });

    const { stdout } = await run('/bin/sh', [
      '-c',
      [
        `sink=${directory.path}/boot.log supervisor=${entry} halted=0 status=failed halted_wait=0`,
        'log() { printf "%s\\n" "$*" >>"$sink"; }',
        'is_trusted_entry() { test -x "$1"; }',
        handoverSection(),
      ].join('\n'),
    ]);

    expect(stdout).toBe('supervised\n');
  });

  it('should stop the machine through the Machines API after a critical step halted the boot, and never start the supervisor', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-boot-'),
    );
    const entry = join(directory.path, 'supervisor');
    const sink = join(directory.path, 'boot.log');
    await writeFile(entry, '#!/bin/sh\necho supervised\n', { mode: 0o755 });
    await writeFile(sink, '');

    const { received, output } = await withApi(
      directory.path,
      200,
      async (api) => {
        const child = spawn(
          '/bin/sh',
          [
            '-c',
            [
              `sink=${sink} supervisor=${entry} fly_api=${api.socket} halted=1 status=failed halted_wait=0`,
              'log() { printf "%s\\n" "$*" >>"$sink"; }',
              'is_trusted_entry() { test -x "$1"; }',
              handoverSection(),
            ].join('\n'),
          ],
          { env: { ...process.env, ...MACHINE_ENV } },
        );
        let printed = '';
        child.stdout.on('data', (chunk: Buffer) => {
          printed += chunk.toString();
        });
        await api.arrived;
        // the request is answered before the boot logs its outcome
        while (
          !(await readFile(sink, 'utf8')).includes('halt=stop requested')
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        child.kill();

        return { received: api.received.slice(0, 1), output: printed };
      },
    );

    expect({ received, output, log: await readFile(sink, 'utf8') }).toEqual({
      received: ['POST /v1/apps/oa-probe/machines/148e21d9a30d08/stop'],
      output: '',
      log: expect.stringContaining('handover=none: a critical step failed'),
    });
  });
});

describe('fn:stopSection', () => {
  it.each([
    [200, 0],
    [412, 1],
  ])(
    'should exit by whether the Machines API answered %i with a 2xx status',
    async (status, code) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-boot-'),
      );

      const exited = await withApi(directory.path, status, async (api) =>
        run(
          '/bin/sh',
          [
            '-c',
            `sink=/dev/null fly_api=${api.socket}\n${stopSection()}\nstop_machine`,
          ],
          { env: { ...process.env, ...MACHINE_ENV } },
        ).then(
          () => 0,
          (error: { code: number }) => error.code,
        ),
      );

      expect(exited).toBe(code);
    },
  );

  it('should send no request for an app name that could change the request path', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-boot-'),
    );

    const { exited, received } = await withApi(
      directory.path,
      200,
      async (api) => ({
        exited: await run(
          '/bin/sh',
          [
            '-c',
            `sink=/dev/null fly_api=${api.socket}\n${stopSection()}\nstop_machine`,
          ],
          { env: { ...process.env, ...MACHINE_ENV, FLY_APP_NAME: '../apps' } },
        ).then(
          () => 0,
          (error: { code: number }) => error.code,
        ),
        received: api.received,
      }),
    );

    expect({ failed: exited !== 0, received }).toEqual({
      failed: true,
      received: [],
    });
  });
});
