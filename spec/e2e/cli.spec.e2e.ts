import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';
import { pathToFileURL } from 'node:url';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

import { runOffline } from '../fixtures/network-block';

import type { Readable } from 'node:stream';

const packedBin = process.env.OPEN_AGENT_PACKED_BIN;
const STAGE_TIMEOUT_MS = 15_000;
const pendingConnection =
  'data:text/javascript,' +
  encodeURIComponent(
    'import {createServer} from "node:net"; createServer().listen(0,"127.0.0.1");',
  );

const FLUSH_WAIT_MARKER = '[SAF05:FLUSH_WAIT]';
const heldFlush =
  'data:text/javascript,' +
  encodeURIComponent(`
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, encoding, callback) => {
      if (chunk !== '') return write(chunk, encoding, callback);
      write('${FLUSH_WAIT_MARKER}\\n');
      const done = typeof encoding === 'function' ? encoding : callback;
      setTimeout(() => done?.(), 1000);
      return true;
    };
  `);
const HANGING_FETCH_MARKER = '[SAF05:FETCH_HANGING]';
/** a preloaded module whose network fetch stays pending, then fails like a dropped connection */
const hangingFetch =
  'data:text/javascript,' +
  encodeURIComponent(`
    const fetchLocal = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input?.url ?? String(input));
      if (['data:', 'blob:', 'file:'].includes(url.protocol)) return fetchLocal(input, init);
      process.stderr.write('${HANGING_FETCH_MARKER}\\n');
      return new Promise((_, reject) =>
        setTimeout(() => reject(new TypeError('fetch failed')), 1000),
      );
    };
  `);

/** create flags that leave a missing provider credential as the only prerequisite */
const OFFLINE_CREATE_FLAGS = [
  '--json',
  '--verbose',
  '--non-interactive',
  '--no-local-credentials',
  '--no-github',
  '--no-plugins',
  '--no-git-identity',
  '--network',
  'none',
  '--no-proxy',
];
/** a non-interactive full setup of one workstation */
const OFFLINE_SETUP_ARGUMENTS = [
  'setup',
  'devbox',
  '--section',
  'all',
  '--json',
  '--non-interactive',
  '--no-local-credentials',
];

async function withIsolatedCli<T>(
  run: (cwd: string, env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'open-agent-e2e-'));
  const env = {
    PATH: process.env.PATH,
    HOME: cwd,
    TMPDIR: cwd,
    NO_COLOR: '1',
  };
  try {
    return await run(cwd, env);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * waits until a child process stream has produced a marker
 * @param stream child stdout or stderr
 * @param marker text that signals the child reached the awaited stage
 */
async function waitForOutput(
  stream: Readable | null,
  marker: string,
): Promise<void> {
  let seen = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${marker}`)),
      STAGE_TIMEOUT_MS,
    );
    stream?.on('data', (chunk: Buffer | string) => {
      seen += chunk.toString();
      if (seen.includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

describe('workflow:installed CLI', () => {
  it.each(
    [
      'color',
      'local-credentials',
      'github',
      'git-identity',
      'plugins',
      'claude-plugins',
      'codex-plugins',
      'proxy',
      'use-exit-node',
    ].flatMap((flag) => [
      { flag, args: [`--${flag}`, `--no-${flag}`] },
      { flag, args: [`--no-${flag}`, `--${flag}`] },
    ]),
  )(
    'should reject conflicting $flag polarity in either order before authentication: $args',
    async ({ args }) => {
      expect(packedBin).toBeDefined();
      const result = await withIsolatedCli(async (cwd, env) =>
        execa(packedBin!, ['create', '--json', ...args], {
          cwd,
          env,
          extendEnv: false,
          reject: false,
        }),
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        command: 'create',
        ok: false,
        error: {
          code: 'USAGE',
          message: expect.stringContaining('mutually exclusive'),
        },
      });
      expect(result.stdout).not.toContain('Sprites API token');
    },
  );

  it.each([
    '--no-pair',
    '--include-pairing',
    '--no-include-pairing',
    '--no-with-t3-pair-code',
    '--no-no-github',
    '--no-no-local-credentials',
  ])(
    'should reject obsolete or double-negated %s before authentication',
    async (flag) => {
      expect(packedBin).toBeDefined();
      const result = await withIsolatedCli(async (cwd, env) =>
        execa(packedBin!, ['create', '--json', flag], {
          cwd,
          env,
          extendEnv: false,
          reject: false,
        }),
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        command: 'create',
        ok: false,
        error: { code: 'USAGE', message: expect.stringContaining(flag) },
      });
      expect(result.stdout).not.toContain('Sprites API token');
    },
  );

  it.each(
    ['create', 'setup', 'show'].flatMap((command) =>
      ['--with-pair-code', '--with-t3-pair-code'].map((flag) => ({
        command,
        flag,
      })),
    ),
  )(
    'should accept explicit pairing through $flag on $command before missing-token INPUT',
    async ({ command, flag }) => {
      expect(packedBin).toBeDefined();
      const result = await withIsolatedCli(async (cwd, env) =>
        execa(packedBin!, [command, '--json', flag, '--no-local-credentials'], {
          cwd,
          env,
          extendEnv: false,
          reject: false,
        }),
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('environment: started');
      expect(result.stderr).toContain('command: failed');
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        command,
        ok: false,
        error: { code: 'INPUT' },
      });
    },
  );

  it.each([
    { command: 'create', args: ['--name', 'Bad_Name'] },
    { command: 'show', args: ['Bad_Name'] },
    { command: 'terminate', args: ['Bad_Name', '--yes'] },
  ])(
    'should reject an invalid $command name before opening a selected env file',
    async ({ command, args }) => {
      expect(packedBin).toBeDefined();
      const result = await withIsolatedCli(async (cwd, env) =>
        execa(
          packedBin!,
          [command, ...args, '--json', '--env-file', join(cwd, 'missing.env')],
          { cwd, env, extendEnv: false, reject: false },
        ),
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        command,
        ok: false,
        error: { code: 'INPUT', message: expect.stringContaining('DNS label') },
      });
    },
  );

  it('should require exact termination consent before env-file access when process mode disables prompts', async () => {
    expect(packedBin).toBeDefined();
    const result = await withIsolatedCli(async (cwd, env) =>
      execa(packedBin!, ['terminate', '--env-file', join(cwd, 'missing.env')], {
        cwd,
        env: { ...env, CI: 'true' },
        extendEnv: false,
        reject: false,
        all: true,
      }),
    );

    expect(result.exitCode).toBe(2);
    expect(result.all).toContain('exact workstation name and --yes');
    expect(result.all).not.toContain('missing.env');
    expect(result.all).not.toContain('Sprites API token');
  });

  it.each([
    ['terminate', '--yes'],
    ['terminate', 'review-check'],
  ])(
    'should require both target and consent before selected env access for %s',
    async (...args) => {
      expect(packedBin).toBeDefined();
      const result = await withIsolatedCli(async (cwd, env) =>
        execa(
          packedBin!,
          [...args, '--json', '--env-file', join(cwd, 'missing.env')],
          {
            cwd,
            env,
            extendEnv: false,
            reject: false,
          },
        ),
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        command: 'terminate',
        ok: false,
        error: { code: 'USAGE', message: expect.stringContaining('--yes') },
      });
      expect(result.stdout).not.toContain('missing.env');
    },
  );

  it('should report every local token route when no provider credential is available', async () => {
    expect(packedBin).toBeDefined();
    const result = await withIsolatedCli(async (cwd, env) =>
      execa(packedBin!, ['list', '--json', '--no-local-credentials'], {
        cwd,
        env,
        extendEnv: false,
        reject: false,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('environment: started');
    expect(result.stderr).toContain('command: failed');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    const parsed: unknown = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      command: 'list',
      ok: false,
      error: {
        code: 'INPUT',
        details: expect.arrayContaining([
          expect.stringContaining('SPRITES_TOKEN or pass --env-file FILE'),
          expect.stringContaining(
            'env:NAME, file:PATH, or keychain:SERVICE/ACCOUNT',
          ),
          expect.stringContaining('TTY'),
          expect.stringContaining('https://sprites.dev/account'),
        ]),
      },
    });
    expect(JSON.stringify(parsed)).toContain('intended organization');
  });

  it.each([
    { source: 'env', value: 'COR07_EMPTY_TOKEN', mode: 'empty' },
    { source: 'file', value: 'missing-token', mode: 'unreadable' },
    { source: 'file', value: 'empty-token', mode: 'empty' },
  ])(
    'should identify an $mode selected $source source without exposing file contents',
    async ({ source, value, mode }) => {
      expect(packedBin).toBeDefined();
      const result = await withIsolatedCli(async (cwd, env) => {
        if (source === 'file' && mode === 'empty') {
          await writeFile(join(cwd, value), '\n');
        }
        const reference =
          source === 'file' ? `file:${join(cwd, value)}` : `env:${value}`;

        return execa(
          packedBin!,
          [
            'list',
            '--json',
            '--no-local-credentials',
            '--provider-token-source',
            reference,
          ],
          {
            cwd,
            env: source === 'env' ? { ...env, [value]: '' } : env,
            extendEnv: false,
            reject: false,
          },
        );
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('environment: started');
      expect(result.stderr).toContain('command: failed');
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      const parsed = JSON.parse(result.stdout) as {
        error: { code: string; message: string; details?: string[] };
      };
      expect(parsed.error.code).toBe('INPUT');
      expect(parsed.error.message).toContain(value);
      expect(parsed.error.details).toBeUndefined();
      expect(result.stdout).not.toContain('EISDIR');
      expect(result.stdout).not.toContain('ENOENT');
    },
  );

  it('should identify an unreadable selected env file without exposing its raw read failure', async () => {
    expect(packedBin).toBeDefined();
    const result = await withIsolatedCli(async (cwd, env) =>
      execa(
        packedBin!,
        [
          'list',
          '--json',
          '--no-local-credentials',
          '--env-file',
          join(cwd, 'missing.env'),
        ],
        { cwd, env, extendEnv: false, reject: false },
      ),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('environment: started');
    expect(result.stderr).toContain('environment: failed');
    const parsed = JSON.parse(result.stdout) as {
      error: { code: string; message: string; details?: string[] };
    };
    expect(parsed.error.code).toBe('INPUT');
    expect(parsed.error.message).toContain('missing.env');
    expect(parsed.error.details).toBeUndefined();
    expect(result.stdout).not.toContain('ENOENT');
  });

  it('should print the installed manifest version and bare help on stdout', async () => {
    expect(packedBin).toBeDefined();
    const packageRoot = dirname(dirname(await realpath(packedBin!)));
    const manifest = JSON.parse(
      await readFile(join(packageRoot, 'package.json'), 'utf8'),
    ) as { version: string };
    const outputs = await withIsolatedCli(async (cwd, env) =>
      Promise.all([
        execa(packedBin!, ['--version'], {
          cwd,
          env,
          extendEnv: false,
          reject: false,
        }),
        execa(packedBin!, ['-v'], {
          cwd,
          env,
          extendEnv: false,
          reject: false,
        }),
        execa(packedBin!, [], { cwd, env, extendEnv: false, reject: false }),
      ]),
    );

    for (const version of outputs.slice(0, 2)) {
      expect(version.exitCode).toBe(0);
      expect(version.stdout.trim()).toBe(manifest.version);
      expect(version.stderr).toBe('');
    }
    expect(outputs[2].exitCode).toBe(0);
    expect(outputs[2].stdout).toContain('open-agent');
    expect(outputs[2].stderr).toBe('');
  });

  it.each(['--help', '--version', '-v'])(
    'should reject JSON combined with %s as one usage result',
    async (flag) => {
      expect(packedBin).toBeDefined();
      const result = await withIsolatedCli(async (cwd, env) =>
        execa(packedBin!, ['--json', flag], {
          cwd,
          env,
          extendEnv: false,
          reject: false,
        }),
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        command: null,
        ok: false,
        error: { code: 'USAGE' },
      });
    },
  );

  it.each(['list', 'show', 'doctor'])(
    'should reject --yes on %s in both human and JSON modes',
    async (command) => {
      expect(packedBin).toBeDefined();
      const [human, json] = await withIsolatedCli(async (cwd, env) =>
        Promise.all([
          execa(packedBin!, [command, '--yes'], {
            cwd,
            env,
            extendEnv: false,
            reject: false,
          }),
          execa(packedBin!, [command, '--yes', '--json'], {
            cwd,
            env,
            extendEnv: false,
            reject: false,
          }),
        ]),
      );

      expect(human.exitCode).toBe(2);
      expect(human.stdout).toBe('');
      expect(human.stderr).toContain('--yes');
      expect(json.exitCode).toBe(2);
      expect(json.stderr).toBe('');
      expect(json.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(json.stdout)).toMatchObject({
        schemaVersion: 1,
        command,
        ok: false,
        error: { code: 'USAGE' },
      });
    },
  );

  it('should keep verbose stage facts on stderr and one JSON result on stdout', async () => {
    expect(packedBin).toBeDefined();
    const privateValue = 'saf07-private-env-value';
    const result = await withIsolatedCli(async (cwd, env) => {
      const envPath = join(cwd, 'selected.env');
      await writeFile(envPath, `UNRELATED_PRIVATE_VALUE=${privateValue}\n`);

      return execa(
        packedBin!,
        [
          'list',
          '--json',
          '--verbose',
          '--non-interactive',
          '--no-local-credentials',
          '--env-file',
          envPath,
        ],
        { cwd, env, extendEnv: false, reject: false },
      );
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'list',
      ok: false,
      error: { code: 'INPUT' },
    });
    expect(result.stderr).toContain('[verbose] stage=environment event=start');
    expect(result.stderr).toContain('stage=command event=complete');
    expect(result.stderr).toMatch(/durationMs=\d+/u);
    expect(result.stderr).not.toContain(privateValue);
    expect(result.stdout).not.toContain(privateValue);
  });

  it('should report a nested preflight stage for create without provisioning', async () => {
    expect(packedBin).toBeDefined();
    const result = await withIsolatedCli(async (cwd, env) =>
      execa(
        packedBin!,
        [
          'create',
          '--json',
          '--verbose',
          '--non-interactive',
          '--no-local-credentials',
          '--no-github',
          '--no-plugins',
          '--no-git-identity',
          '--network',
          'none',
          '--no-proxy',
        ],
        { cwd, env, extendEnv: false, reject: false },
      ),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'create',
      ok: false,
      error: { code: 'INPUT' },
    });
    expect(result.stderr).toContain('stage=create.preflight event=start');
    expect(result.stderr).toContain('stage=create.preflight event=complete');
    expect(result.stderr).not.toContain('stage=create.provider');
  });

  it('should record every outbound attempt kind the network hook blocks', async () => {
    const { result, attempts } = await withIsolatedCli(async (cwd, env) => {
      const script = join(cwd, 'attempts.mjs');
      await writeFile(
        script,
        `
          import http from 'node:http';
          import https from 'node:https';
          import net from 'node:net';
          import tls from 'node:tls';
          const tries = [
            () => fetch('https://example.invalid/'),
            () => http.get('http://example.invalid/'),
            () => https.request('https://example.invalid/'),
            () => net.connect(443, 'example.invalid'),
            () => tls.connect(443, 'example.invalid'),
          ];
          for (const attempt of tries) {
            try { await attempt(); } catch {}
          }
        `,
      );

      return runOffline(script, [], { cwd, env });
    });

    expect(result.exitCode).toBe(0);
    expect(attempts).toEqual([
      { kind: 'fetch', target: 'https://example.invalid/' },
      { kind: 'http', target: 'http://example.invalid/' },
      { kind: 'https', target: 'https://example.invalid/' },
      { kind: 'net.connect', target: 'example.invalid:443' },
      { kind: 'socket', target: 'example.invalid' },
    ]);
  });

  it('should record the provider request an installed command makes under the network hook', async () => {
    expect(packedBin).toBeDefined();
    const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
      runOffline(packedBin!, ['list', '--json', '--no-local-credentials'], {
        cwd,
        env: { ...env, SPRITES_TOKEN: 'offline-placeholder' },
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(attempts).toEqual([
      { kind: 'fetch', target: expect.stringContaining('sprites.dev') },
    ]);
  });

  it('should aggregate a missing provider credential into one message before any provider call', async () => {
    expect(packedBin).toBeDefined();
    const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
      runOffline(
        packedBin!,
        ['create', '--name', 'missing-credential', ...OFFLINE_CREATE_FLAGS],
        { cwd, env },
      ),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(result.stdout) as {
      error: { message: string; details: string[] };
    };
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      command: 'create',
      ok: false,
      error: {
        code: 'INPUT',
        message: 'Provider prerequisites are missing or misconfigured',
      },
    });
    expect(
      parsed.error.details.filter((detail) => detail.includes('SPRITES_TOKEN')),
    ).toEqual([
      expect.stringMatching(
        /Sprites API token is not set.*https:\/\/sprites\.dev\/account/u,
      ),
    ]);
    expect(result.stderr).toContain('stage=create.preflight event=start');
    expect(result.stderr).not.toContain('stage=create.provider');
    expect(attempts).toEqual([]);
  });

  it('should refuse a wrong-scope provider token offline before any provider call', async () => {
    expect(packedBin).toBeDefined();
    const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
      runOffline(
        packedBin!,
        ['create', '--name', 'wrong-scope', ...OFFLINE_CREATE_FLAGS],
        {
          cwd,
          env: { ...env, SPRITES_TOKEN: 'FlyV1 fm2_generated-macaroon' },
        },
      ),
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'create',
      ok: false,
      error: {
        code: 'INPUT',
        message: 'Provider prerequisites are missing or misconfigured',
        details: [expect.stringContaining('holds a Fly API token')],
      },
    });
    expect(result.stdout).not.toContain('generated-macaroon');
    expect(result.stderr).not.toContain('stage=create.provider');
    expect(attempts).toEqual([]);
  });

  it('should pass the offline prerequisite check and call the provider with the same flags and a valid-shaped token', async () => {
    expect(packedBin).toBeDefined();
    const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
      runOffline(
        packedBin!,
        ['create', '--name', 'valid-shape', ...OFFLINE_CREATE_FLAGS],
        {
          cwd,
          env: { ...env, SPRITES_TOKEN: 'control-org/1234/0123abcd/4567ef89' },
        },
      ),
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'create',
      ok: false,
      error: {
        message: 'Provider preflight checks failed; no workstation was created',
        details: [expect.stringContaining('outbound fetch blocked')],
      },
    });
    expect(attempts).toEqual(
      expect.arrayContaining([
        { kind: 'fetch', target: expect.stringContaining('sprites.dev') },
      ]),
    );
  });

  describe('fly-machine prerequisites', () => {
    /** a deploy token decoding: an organization caveat narrowed to one app */
    const DEPLOY_DECODING = JSON.stringify([
      {
        location: 'https://api.fly.io/v1',
        caveats: [
          { type: 'Organization', body: { id: 1, mask: 'rwcdC' } },
          { type: 'Apps', body: { apps: { '42': 'rwcdC' } } },
        ],
      },
    ]);

    /** an organization token decoding */
    const ORGANIZATION_DECODING = JSON.stringify([
      {
        location: 'https://api.fly.io/v1',
        caveats: [{ type: 'Organization', body: { id: 1, mask: 'rwcdC' } }],
      },
    ]);

    /**
     * runs an offline create for fly-machine with a PATH holding only a
     * flyctl stand-in, or nothing when no stand-in is given
     * @param name workstation name
     * @param env extra environment, such as the token
     * @param standIn what the stand-in prints
     * @param standIn.decoding what it prints for `fly tokens debug`
     * @param standIn.version the version it reports
     * @returns the run and its blocked network attempts
     */
    async function createOnFly(
      name: string,
      env: NodeJS.ProcessEnv,
      standIn?: { decoding: string; version?: string },
    ): Promise<Awaited<ReturnType<typeof runOffline>>> {
      return withIsolatedCli(async (cwd, isolated) => {
        const bin = join(cwd, 'bin');
        await mkdir(bin);
        if (standIn !== undefined) {
          const version = standIn.version ?? '0.4.108';
          await writeFile(join(cwd, 'decoding.json'), standIn.decoding);
          await writeFile(
            join(bin, 'fly'),
            [
              '#!/bin/sh',
              'case "$1" in',
              `  tokens) exec /bin/cat '${join(cwd, 'decoding.json')}' ;;`,
              `  *) echo "fly v${version} darwin/arm64 Commit: test" ;;`,
              'esac',
              '',
            ].join('\n'),
          );
          await chmod(join(bin, 'fly'), 0o755);
        }

        return runOffline(
          packedBin!,
          [
            'create',
            '--name',
            name,
            ...OFFLINE_CREATE_FLAGS,
            '--provider',
            'fly-machine',
          ],
          { cwd, env: { ...isolated, PATH: bin, ...env } },
        );
      });
    }

    /**
     * reads the single JSON document a failed create printed
     * @param result CLI process result
     * @param result.stdout the printed JSON document
     * @returns its error details
     */
    function prerequisiteDetails(result: { stdout: string }): string[] {
      const parsed = JSON.parse(result.stdout) as {
        error: { code: string; message: string; details: string[] };
      };
      expect(parsed.error).toMatchObject({
        code: 'INPUT',
        message: 'Provider prerequisites are missing or misconfigured',
      });

      return parsed.error.details;
    }

    it('should report a missing flyctl and a missing Fly token together before any provider call', async () => {
      expect(packedBin).toBeDefined();
      const { result, attempts } = await createOnFly('fly-missing', {});

      expect(result.exitCode).toBe(1);
      expect(prerequisiteDetails(result)).toEqual([
        expect.stringMatching(
          /fly is not on PATH.*fly\.io\/docs\/flyctl\/install/u,
        ),
        expect.stringMatching(
          /Fly organization token is not set.*FLY_API_TOKEN/u,
        ),
      ]);
      expect(result.stderr).not.toContain('stage=create.provider');
      expect(attempts).toEqual([]);
    });

    it('should report a missing flyctl even when the Fly token is set, before any provider call', async () => {
      expect(packedBin).toBeDefined();
      const { result, attempts } = await createOnFly('fly-no-flyctl', {
        FLY_API_TOKEN: 'FlyV1 fm2_org-macaroon',
      });

      expect(result.exitCode).toBe(1);
      expect(prerequisiteDetails(result)).toEqual([
        expect.stringMatching(
          /fly is not on PATH.*fly\.io\/docs\/flyctl\/install/u,
        ),
      ]);
      expect(result.stdout).not.toContain('org-macaroon');
      expect(result.stderr).not.toContain('stage=create.provider');
      expect(attempts).toEqual([]);
    });

    it('should refuse a flyctl older than 0.4.108 before decoding the token or calling the provider', async () => {
      expect(packedBin).toBeDefined();
      const { result, attempts } = await createOnFly(
        'fly-old-flyctl',
        { FLY_API_TOKEN: 'FlyV1 fm2_org-macaroon' },
        { decoding: ORGANIZATION_DECODING, version: '0.4.107' },
      );

      expect(result.exitCode).toBe(1);
      expect(prerequisiteDetails(result)).toEqual([
        'fly 0.4.107 is older than 0.4.108. Install or upgrade flyctl: https://fly.io/docs/flyctl/install/',
      ]);
      expect(result.stdout).not.toContain('org-macaroon');
      expect(result.stderr).not.toContain('stage=create.provider');
      expect(attempts).toEqual([]);
    });

    it('should refuse a Fly token flyctl decodes as narrower than an organization before any provider call', async () => {
      expect(packedBin).toBeDefined();
      const { result, attempts } = await createOnFly(
        'fly-deploy-token',
        { FLY_API_TOKEN: 'FlyV1 fm2_deploy-macaroon' },
        { decoding: DEPLOY_DECODING },
      );

      expect(result.exitCode).toBe(1);
      expect(prerequisiteDetails(result)).toEqual([
        expect.stringMatching(
          /FLY_API_TOKEN.* is narrowed by its Apps caveat.*fly tokens create org/u,
        ),
      ]);
      expect(result.stdout).not.toContain('deploy-macaroon');
      expect(result.stderr).not.toContain('stage=create.provider');
      expect(attempts).toEqual([]);
    });

    it('should refuse a Sprites token given as the Fly token without decoding it', async () => {
      expect(packedBin).toBeDefined();
      const { result, attempts } = await createOnFly(
        'fly-sprites-token',
        { FLY_API_TOKEN: 'control-org/1234/0123abcd/4567ef89' },
        { decoding: 'never decoded' },
      );

      expect(result.exitCode).toBe(1);
      expect(prerequisiteDetails(result)).toEqual([
        expect.stringContaining('holds a Sprites API token'),
      ]);
      expect(result.stdout).not.toContain('0123abcd');
      expect(attempts).toEqual([]);
    });

    it('should pass the offline check with an organization token and only then call the Machines API', async () => {
      expect(packedBin).toBeDefined();
      const { result, attempts } = await createOnFly(
        'fly-org-token',
        { FLY_API_TOKEN: 'FlyV1 fm2_org-macaroon' },
        { decoding: ORGANIZATION_DECODING },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain('org-macaroon');
      expect(attempts).toEqual(
        expect.arrayContaining([
          {
            kind: 'fetch',
            target: expect.stringContaining('api.machines.dev'),
          },
        ]),
      );
    });
  });

  it.each([
    {
      rule: 'zero harnesses',
      env: { OPEN_AGENT_HARNESSES: ',' },
      flags: [],
      details: [expect.stringContaining('At least one harness')],
    },
    {
      rule: 'an exit node with network none',
      env: {},
      flags: ['--use-exit-node'],
      details: [expect.stringMatching(/--use-exit-node.*"none" does not/u)],
    },
    {
      rule: 'a release channel the ACP agent does not declare',
      env: { OPEN_AGENT_RELEASE: 'weekly' },
      flags: [],
      details: [
        expect.stringMatching(
          /Unknown release channel "weekly".*available: stable, nightly/u,
        ),
      ],
    },
    {
      rule: 'a machine size the provider does not offer',
      env: { OPEN_AGENT_CPU: '99', OPEN_AGENT_MEM: '99' },
      flags: [],
      details: [
        expect.stringMatching(
          /offers no machine with 99 CPUs and 99 GB; it offers at most 8 CPUs and 16 GB/u,
        ),
      ],
    },
    {
      rule: 'zero harnesses and an exit node with network none together',
      env: { OPEN_AGENT_HARNESSES: ',' },
      flags: ['--use-exit-node'],
      details: [
        expect.stringContaining('At least one harness'),
        expect.stringMatching(/--use-exit-node.*"none" does not/u),
      ],
    },
  ])(
    'should reject $rule as one aggregated input error before any provider call',
    async ({ env: selection, flags, details }) => {
      expect(packedBin).toBeDefined();
      const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
        runOffline(
          packedBin!,
          ['create', '--name', 'selection', ...OFFLINE_CREATE_FLAGS, ...flags],
          {
            cwd,
            env: {
              ...env,
              ...selection,
              SPRITES_TOKEN: 'selection-org/1234/0123abcd/4567ef89',
            },
          },
        ),
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: 'create',
        ok: false,
        error: {
          code: 'INPUT',
          message: 'The workstation selection is invalid',
          details,
        },
      });
      expect(result.stderr).not.toContain('stage=create.provider');
      expect(attempts).toEqual([]);
    },
  );

  it('should validate selection flags as one usage result before any provider call', async () => {
    expect(packedBin).toBeDefined();
    const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
      runOffline(
        packedBin!,
        ['create', '--json', '--network', 'bogus', '--provider', 'absent'],
        { cwd, env },
      ),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'create',
      ok: false,
      error: { code: 'USAGE' },
    });
    expect(result.stdout).toContain('bogus');
    expect(result.stdout).toContain('absent');
    expect(attempts).toEqual([]);
  });

  it.each([['create'], ['setup']])(
    'should reject an unknown %s release channel flag as one usage result before any provider call',
    async (command) => {
      expect(packedBin).toBeDefined();
      const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
        runOffline(
          packedBin!,
          [command, '--json', '--release', 'weekly', '--provider', 'sprite'],
          { cwd, env },
        ),
      );

      expect(result.exitCode).toBe(2);
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command,
        ok: false,
        error: { code: 'USAGE' },
      });
      expect(result.stdout).toContain('weekly');
      expect(attempts).toEqual([]);
    },
  );

  it.each([['create'], ['setup']])(
    'should list the release channel flag in %s help',
    async (command) => {
      expect(packedBin).toBeDefined();
      const result = await withIsolatedCli(async (cwd, env) =>
        execa(packedBin!, [command, '--help'], {
          cwd,
          env,
          extendEnv: false,
          reject: false,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--release');
      expect(result.stdout).toContain('stable, nightly');
    },
  );

  it.each([['list'], ['show'], ['doctor'], ['terminate']])(
    'should list the provider flag and its token source meaning in %s help',
    async (command) => {
      expect(packedBin).toBeDefined();
      const result = await withIsolatedCli(async (cwd, env) =>
        execa(packedBin!, [command, '--help'], {
          cwd,
          env,
          extendEnv: false,
          reject: false,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--provider PROVIDER');
      expect(result.stdout).toContain('sprite, fly-machine');
      expect(result.stdout).toContain('--provider-token-source belongs to');
    },
  );

  it('should give a list token source to the provider --provider names', async () => {
    expect(packedBin).toBeDefined();
    const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
      runOffline(
        packedBin!,
        [
          'list',
          '--json',
          '--no-local-credentials',
          '--provider',
          'fly-machine',
          '--provider-token-source',
          'env:OPEN_AGENT_TEST_SOURCE',
        ],
        {
          cwd,
          env: { ...env, OPEN_AGENT_TEST_SOURCE: 'offline-placeholder' },
        },
      ),
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'list',
      ok: false,
      error: {
        code: 'INPUT',
        details: [
          expect.stringMatching(/^fly-machine: .*is not a Fly API token/u),
          'sprite: workstation status unknown, no Sprites API token was found; supply one in SPRITES_TOKEN, or with --provider sprite --provider-token-source, to list its workstations',
        ],
      },
    });
    expect(attempts).toEqual([]);
  });

  it.each([['show'], ['doctor'], ['terminate']])(
    'should reject an unknown %s provider flag as one usage result before any provider call',
    async (command) => {
      expect(packedBin).toBeDefined();
      const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
        runOffline(
          packedBin!,
          [command, 'devbox', '--json', '--provider', 'bogus'],
          {
            cwd,
            env,
          },
        ),
      );

      expect(result.exitCode).toBe(2);
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command,
        ok: false,
        error: { code: 'USAGE' },
      });
      expect(result.stdout).toContain('bogus');
      expect(attempts).toEqual([]);
    },
  );

  it.each([['show'], ['doctor'], ['terminate']])(
    'should answer %s from the named provider even when another provider has a ready credential',
    async (command) => {
      expect(packedBin).toBeDefined();
      const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
        runOffline(
          packedBin!,
          [
            command,
            'devbox',
            '--provider',
            'fly-machine',
            ...(command === 'terminate' ? ['--yes'] : []),
            '--json',
            '--non-interactive',
            '--no-local-credentials',
          ],
          { cwd, env: { ...env, SPRITES_TOKEN: 'test-org/1/0abc/0def' } },
        ),
      );

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command,
        ok: false,
        error: {
          code: 'INPUT',
          message: 'Provider prerequisites are missing or misconfigured',
          details: expect.arrayContaining([
            expect.stringContaining('FLY_API_TOKEN'),
          ]),
        },
      });
      expect(attempts).toEqual([]);
    },
  );

  it.each([
    ['create', '--cpu'],
    ['create', '--mem'],
    ['setup', '--cpu'],
    ['setup', '--mem'],
  ])(
    'should reject a non-whole %s %s value as one usage result before any provider call',
    async (command, flag) => {
      expect(packedBin).toBeDefined();
      const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
        runOffline(
          packedBin!,
          [command, '--json', flag, '1.5', '--provider', 'sprite'],
          { cwd, env },
        ),
      );

      expect(result.exitCode).toBe(2);
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command,
        ok: false,
        error: { code: 'USAGE' },
      });
      expect(result.stdout).toContain('1.5');
      expect(attempts).toEqual([]);
    },
  );

  it.each([['create'], ['setup']])(
    'should list the machine size flags in %s help',
    async (command) => {
      expect(packedBin).toBeDefined();
      const result = await withIsolatedCli(async (cwd, env) =>
        execa(packedBin!, [command, '--help'], {
          cwd,
          env,
          extendEnv: false,
          reject: false,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--cpu');
      expect(result.stdout).toContain('--mem');
    },
  );

  it.each([
    {
      flags: ['--cpu', '0'],
      exitCode: 1,
      error: {
        code: 'INPUT',
        message: 'The workstation selection is invalid',
        details: [expect.stringContaining('--cpu')],
      },
    },
    {
      flags: ['--mem', '17'],
      exitCode: 1,
      error: {
        code: 'INPUT',
        message: 'The workstation selection is invalid',
        details: [
          expect.stringMatching(
            /offers no machine with 2 CPUs and 17 GB; it offers at most 8 CPUs and 16 GB/u,
          ),
        ],
      },
    },
    {
      flags: ['--idle-minutes', '-1'],
      exitCode: 1,
      error: {
        code: 'INPUT',
        message: 'The workstation selection is invalid',
        details: [expect.stringContaining('--idle-minutes')],
      },
    },
    {
      flags: ['--hold-max-minutes', '0'],
      exitCode: 1,
      error: {
        code: 'INPUT',
        message: 'The workstation selection is invalid',
        details: [expect.stringContaining('--hold-max-minutes')],
      },
    },
    {
      flags: ['--idle-minutes', '61'],
      exitCode: 1,
      error: {
        code: 'INPUT',
        message: 'The workstation selection is invalid',
        details: [
          expect.stringMatching(
            /--idle-minutes.*61 minutes.*"sprite".*at most 60 minutes/,
          ),
        ],
      },
    },
    {
      flags: ['--hold-max-minutes', '61'],
      exitCode: 1,
      error: {
        code: 'INPUT',
        message: 'The workstation selection is invalid',
        details: [
          expect.stringMatching(
            /--hold-max-minutes.*61 minutes.*"sprite".*at most 60 minutes/,
          ),
        ],
      },
    },
    {
      flags: ['--idle-minutes', '60'],
      exitCode: 1,
      error: {
        code: 'INPUT',
        message: 'Provider prerequisites are missing or misconfigured',
      },
    },
    {
      flags: ['--hold-max-minutes', '60'],
      exitCode: 1,
      error: {
        code: 'INPUT',
        message: 'Provider prerequisites are missing or misconfigured',
      },
    },
    {
      flags: ['--update-due-days', '366'],
      exitCode: 1,
      error: {
        code: 'INPUT',
        message: 'The workstation selection is invalid',
        details: [expect.stringContaining('--update-due-days')],
      },
    },
    {
      flags: ['--update-due-days', '1.5'],
      exitCode: 2,
      error: {
        code: 'USAGE',
        message: expect.stringContaining('update-due-days'),
      },
    },
    {
      flags: ['--update-due-days', '0'],
      exitCode: 1,
      error: {
        code: 'INPUT',
        message: 'The workstation selection is invalid',
        details: [expect.stringContaining('--update-due-days')],
      },
    },
    {
      flags: ['--update-due-days', 'soon'],
      exitCode: 2,
      error: {
        code: 'USAGE',
        message: expect.stringContaining('update-due-days'),
      },
    },
    {
      flags: ['--network', 'unknown'],
      exitCode: 2,
      error: { code: 'USAGE', message: expect.stringContaining('unknown') },
    },
    {
      flags: ['--harness', 'unknown'],
      exitCode: 2,
      error: { code: 'USAGE', message: expect.stringContaining('unknown') },
    },
    {
      flags: ['--idle-minutes', '0'],
      exitCode: 1,
      error: {
        code: 'INPUT',
        message: 'Provider prerequisites are missing or misconfigured',
      },
    },
  ])(
    'should settle create $flags before any provider call',
    async ({ flags, exitCode, error }) => {
      expect(packedBin).toBeDefined();
      const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
        runOffline(
          packedBin!,
          // the selection flags come last so they override the offline network
          ['create', '--name', 'selection', ...OFFLINE_CREATE_FLAGS, ...flags],
          { cwd, env },
        ),
      );

      expect(result.exitCode).toBe(exitCode);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: 'create',
        ok: false,
        error,
      });
      expect(attempts).toEqual([]);
    },
  );

  it.each([
    {
      flags: ['--idle-minutes', '-1'],
      exitCode: 1,
      error: {
        code: 'INPUT',
        message: 'The workstation selection is invalid',
        details: [expect.stringContaining('--idle-minutes')],
      },
    },
    {
      flags: ['--hold-max-minutes', '0'],
      exitCode: 1,
      error: {
        code: 'INPUT',
        message: 'The workstation selection is invalid',
        details: [expect.stringContaining('--hold-max-minutes')],
      },
    },
    {
      flags: ['--update-due-days', '366'],
      exitCode: 1,
      error: {
        code: 'INPUT',
        message: 'The workstation selection is invalid',
        details: [expect.stringContaining('--update-due-days')],
      },
    },
    {
      flags: ['--update-due-days', '1.5'],
      exitCode: 2,
      error: {
        code: 'USAGE',
        message: expect.stringContaining('update-due-days'),
      },
    },
    {
      flags: ['--update-due-days', '0'],
      exitCode: 1,
      error: {
        code: 'INPUT',
        message: 'The workstation selection is invalid',
        details: [expect.stringContaining('--update-due-days')],
      },
    },
    {
      flags: ['--update-due-days', 'soon'],
      exitCode: 2,
      error: {
        code: 'USAGE',
        message: expect.stringContaining('update-due-days'),
      },
    },
    {
      flags: ['--network', 'unknown'],
      exitCode: 2,
      error: { code: 'USAGE', message: expect.stringContaining('unknown') },
    },
    {
      flags: ['--harness', 'unknown'],
      exitCode: 2,
      error: { code: 'USAGE', message: expect.stringContaining('unknown') },
    },
  ])(
    'should refuse setup $flags before any provider call',
    async ({ flags, exitCode, error }) => {
      expect(packedBin).toBeDefined();
      const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
        runOffline(packedBin!, [...OFFLINE_SETUP_ARGUMENTS, ...flags], {
          cwd,
          env: { ...env, SPRITES_TOKEN: 'offline-placeholder' },
        }),
      );

      expect(result.exitCode).toBe(exitCode);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: 'setup',
        ok: false,
        error,
      });
      expect(attempts).toEqual([]);
    },
  );

  it('should accept a zero setup idle timeout and reach the provider lookup', async () => {
    expect(packedBin).toBeDefined();
    const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
      runOffline(
        packedBin!,
        [...OFFLINE_SETUP_ARGUMENTS, '--idle-minutes', '0'],
        { cwd, env: { ...env, SPRITES_TOKEN: 'offline-placeholder' } },
      ),
    );
    const parsed = JSON.parse(result.stdout) as {
      error: { message: string };
    };

    expect(result.exitCode).toBe(1);
    expect(parsed.error.message).not.toBe(
      'The workstation selection is invalid',
    );
    expect(attempts).toEqual([
      { kind: 'fetch', target: expect.stringContaining('/sprites/devbox') },
    ]);
  });

  it('should accept an update interval in the tools section and reach the provider lookup', async () => {
    expect(packedBin).toBeDefined();
    const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
      runOffline(
        packedBin!,
        [
          'setup',
          'devbox',
          '--section',
          'tools',
          '--update-due-days',
          '3',
          '--json',
          '--non-interactive',
          '--no-local-credentials',
        ],
        { cwd, env: { ...env, SPRITES_TOKEN: 'offline-placeholder' } },
      ),
    );
    const parsed = JSON.parse(result.stdout) as {
      error: { message: string };
    };

    expect(result.exitCode).toBe(1);
    expect(parsed.error.message).not.toBe(
      'The workstation selection is invalid',
    );
    expect(attempts).toEqual([
      { kind: 'fetch', target: expect.stringContaining('/sprites/devbox') },
    ]);
  });

  it('should refuse an update interval in a section that does not own it before any provider call', async () => {
    expect(packedBin).toBeDefined();
    const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
      runOffline(
        packedBin!,
        [
          'setup',
          'devbox',
          '--section',
          'network',
          '--update-due-days',
          '3',
          '--json',
          '--non-interactive',
          '--no-local-credentials',
        ],
        { cwd, env: { ...env, SPRITES_TOKEN: 'offline-placeholder' } },
      ),
    );

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'setup',
      ok: false,
      error: { code: 'USAGE' },
    });
    expect(attempts).toEqual([]);
  });

  it('should accept a release channel in the agent section and reach the provider lookup', async () => {
    expect(packedBin).toBeDefined();
    const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
      runOffline(
        packedBin!,
        [
          'setup',
          'devbox',
          '--section',
          'agent',
          '--release',
          'nightly',
          '--json',
          '--non-interactive',
          '--no-local-credentials',
        ],
        { cwd, env: { ...env, SPRITES_TOKEN: 'offline-placeholder' } },
      ),
    );
    const parsed = JSON.parse(result.stdout) as {
      error: { message: string };
    };

    expect(result.exitCode).toBe(1);
    expect(parsed.error.message).not.toBe(
      'The workstation selection is invalid',
    );
    expect(attempts).toEqual([
      { kind: 'fetch', target: expect.stringContaining('/sprites/devbox') },
    ]);
  });

  it('should accept a machine size on setup and reach the provider lookup', async () => {
    expect(packedBin).toBeDefined();
    const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
      runOffline(
        packedBin!,
        [
          'setup',
          'devbox',
          '--section',
          'tools',
          '--cpu',
          '4',
          '--mem',
          '8',
          '--json',
          '--non-interactive',
          '--no-local-credentials',
        ],
        { cwd, env: { ...env, SPRITES_TOKEN: 'offline-placeholder' } },
      ),
    );
    const parsed = JSON.parse(result.stdout) as {
      error: { message: string };
    };

    expect(result.exitCode).toBe(1);
    expect(parsed.error.message).not.toBe(
      'The workstation selection is invalid',
    );
    expect(attempts).toEqual([
      { kind: 'fetch', target: expect.stringContaining('/sprites/devbox') },
    ]);
  });

  it('should refuse a release channel in a section that does not own it before any provider call', async () => {
    expect(packedBin).toBeDefined();
    const { result, attempts } = await withIsolatedCli(async (cwd, env) =>
      runOffline(
        packedBin!,
        [
          'setup',
          'devbox',
          '--section',
          'network',
          '--release',
          'nightly',
          '--json',
          '--non-interactive',
          '--no-local-credentials',
        ],
        { cwd, env: { ...env, SPRITES_TOKEN: 'offline-placeholder' } },
      ),
    );

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'setup',
      ok: false,
      error: { code: 'USAGE' },
    });
    expect(attempts).toEqual([]);
  });

  it('should flush output despite a pending network handle', async () => {
    expect(packedBin).toBeDefined();
    const result = await withIsolatedCli(async (cwd, env) =>
      execa(execPath, ['--import', pendingConnection, packedBin!, '--help'], {
        cwd,
        env,
        extendEnv: false,
        reject: false,
        timeout: 2_000,
      }),
    );

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('open-agent');
    expect(result.stderr).toBe('');
  });

  it('should retain the failure status of invalid JSON arguments', async () => {
    expect(packedBin).toBeDefined();
    const result = await withIsolatedCli(async (cwd, env) =>
      execa(
        execPath,
        ['--import', pendingConnection, packedBin!, '--json', '--help'],
        { cwd, env, extendEnv: false, reject: false, timeout: 2_000 },
      ),
    );

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      command: null,
      ok: false,
      error: { code: 'USAGE' },
    });
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('should prepare one JSON fallback with recovery identity for cyclic diagnostic data', async () => {
    expect(packedBin).toBeDefined();
    const packageRoot = dirname(dirname(await realpath(packedBin!)));
    const executeUrl = pathToFileURL(
      join(packageRoot, 'lib/cli/execute.js'),
    ).href;
    const source = `
      import { emitResult } from ${JSON.stringify(executeUrl)};
      const cyclic = {}; cyclic.self = cyclic;
      const state = { emitted: false, command: 'show', errors: [] };
      const result = { command: 'show', ok: false, error: {
        code: 'PROVIDER', message: 'provider failed', machine: 'retained',
        machineId: 'sprite-retained', setupIncomplete: true,
        outcome: 'unknown', details: ['Inspect retained machine']
      }, data: { cyclic } };
      emitResult(result, { json: true }, state);
      emitResult(result, { json: true }, state);
    `;
    const result = await withIsolatedCli(async (cwd, env) =>
      execa(execPath, ['--input-type=module', '-e', source], {
        cwd,
        env,
        extendEnv: false,
        reject: false,
        timeout: 2_000,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'show',
      ok: false,
      error: {
        code: 'UNEXPECTED',
        machine: 'retained',
        machineId: 'sprite-retained',
        setupIncomplete: true,
        outcome: 'unknown',
        details: ['Inspect retained machine'],
      },
    });
    expect(result.stdout).not.toContain('cyclic');
  });

  it('should keep a created machine recoverable when success data cannot be rendered', async () => {
    expect(packedBin).toBeDefined();
    const packageRoot = dirname(dirname(await realpath(packedBin!)));
    const executeUrl = pathToFileURL(
      join(packageRoot, 'lib/cli/execute.js'),
    ).href;
    const source = `
      import { emitResult } from ${JSON.stringify(executeUrl)};
      const cyclic = {}; cyclic.self = cyclic;
      emitResult({ command: 'create', ok: true, data: {
        machine: { name: 'retained-created', id: 'sprite-created' },
        diagnostic: cyclic,
      } }, { json: true }, { emitted: false, command: 'create', errors: [] });
    `;
    const result = await withIsolatedCli(async (cwd, env) =>
      execa(execPath, ['--input-type=module', '-e', source], {
        cwd,
        env,
        extendEnv: false,
        reject: false,
        timeout: 2_000,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'create',
      ok: false,
      error: {
        code: 'UNEXPECTED',
        machine: 'retained-created',
        machineId: 'sprite-created',
        outcome: 'unknown',
      },
    });
  });

  it('should preserve deletion guidance without claiming a retained Sprite after render failure', async () => {
    expect(packedBin).toBeDefined();
    const packageRoot = dirname(dirname(await realpath(packedBin!)));
    const executeUrl = pathToFileURL(
      join(packageRoot, 'lib/cli/execute.js'),
    ).href;
    const source = `
      import { emitResult } from ${JSON.stringify(executeUrl)};
      const cyclic = {}; cyclic.self = cyclic;
      emitResult({ command: 'terminate', ok: true, data: {
        machine: { name: 'deleted-machine', id: 'sprite-deleted' },
        sprite: { status: 'deleted', id: 'sprite-deleted', name: 'deleted-machine' },
        tailnet: { status: 'cleanup required', diagnostic: cyclic },
      } }, { json: true }, { emitted: false, command: 'terminate', errors: [] });
    `;
    const result = await withIsolatedCli(async (cwd, env) =>
      execa(execPath, ['--input-type=module', '-e', source], {
        cwd,
        env,
        extendEnv: false,
        reject: false,
        timeout: 2_000,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      schemaVersion: 1,
      command: 'terminate',
      ok: false,
      error: {
        code: 'UNEXPECTED',
        machine: 'deleted-machine',
        machineId: 'sprite-deleted',
        outcome: 'unknown',
        details: [expect.stringContaining('Workstation deleted')],
      },
    });
    expect(result.stdout).not.toContain('resource was retained');
  });

  it('should keep local-credential setup and list recovery machine-free', async () => {
    expect(packedBin).toBeDefined();
    const packageRoot = dirname(dirname(await realpath(packedBin!)));
    const executeUrl = pathToFileURL(
      join(packageRoot, 'lib/cli/execute.js'),
    ).href;
    const source = `
      import { emitResult } from ${JSON.stringify(executeUrl)};
      const cyclic = {}; cyclic.self = cyclic;
      const localCredential = { status: 'replaced', scope: 'this computer; all workstations', diagnostic: cyclic };
      emitResult({ command: 'setup', ok: true, data: { localCredential } },
        { json: true }, { emitted: false, command: 'setup', errors: [] });
      emitResult({ command: 'list', ok: true, data: { machines: [{ name: 'listed', diagnostic: cyclic }] } },
        { json: true }, { emitted: false, command: 'list', errors: [] });
    `;
    const result = await withIsolatedCli(async (cwd, env) =>
      execa(execPath, ['--input-type=module', '-e', source], {
        cwd,
        env,
        extendEnv: false,
        reject: false,
        timeout: 2_000,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const [index, command] of ['setup', 'list'].entries()) {
      const output = JSON.parse(lines[index]!);
      expect(output).toMatchObject({
        schemaVersion: 1,
        command,
        ok: false,
        error: { code: 'UNEXPECTED' },
      });
      expect(output.error).not.toHaveProperty('machine');
      expect(output.error).not.toHaveProperty('machineId');
      expect(output.error).not.toHaveProperty('outcome');
    }
  });

  it('should own a result after one write attempt to a closed OS stdout pipe', async () => {
    expect(packedBin).toBeDefined();
    const packageRoot = dirname(dirname(await realpath(packedBin!)));
    const executeUrl = pathToFileURL(
      join(packageRoot, 'lib/cli/execute.js'),
    ).href;
    const source = `
      import { emitResult } from ${JSON.stringify(executeUrl)};
      let writeErrors = 0;
      process.stdout.on('error', () => { writeErrors += 1; });
      process.stdin.once('data', () => {
        const state = { emitted: false, command: 'show', errors: [] };
        emitResult({ command: 'show', ok: false, error: {
          code: 'PROVIDER', message: 'provider failed', machine: 'known-machine'
        } }, { json: true }, state);
        setTimeout(() => process.stderr.write(JSON.stringify({
          emitted: state.emitted, exitCode: process.exitCode, writeErrors
        }) + '\\n'), 30);
      });
    `;
    const result = await withIsolatedCli(async (cwd, env) => {
      const child = spawn(execPath, ['--input-type=module', '-e', source], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let diagnostic = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        diagnostic += chunk;
      });
      child.stdout.destroy();
      child.stdin.end('go');
      const [exitCode] = await once(child, 'close');

      return { exitCode, diagnostic };
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.diagnostic)).toEqual({
      emitted: true,
      exitCode: 1,
      writeErrors: 1,
    });
  });

  it('should combine two real parser choice errors into one JSON result', async () => {
    expect(packedBin).toBeDefined();
    const result = await withIsolatedCli(async (cwd, env) =>
      execa(
        packedBin!,
        [
          'setup',
          '--json',
          '--section',
          'invalid-one',
          '--harness',
          'invalid-two',
        ],
        { cwd, env, extendEnv: false, reject: false, timeout: 2_000 },
      ),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    const output = JSON.parse(result.stdout) as {
      error: { message: string };
    };
    expect(output).toMatchObject({
      schemaVersion: 1,
      command: 'setup',
      ok: false,
      error: { code: 'USAGE' },
    });
    expect(output.error.message).toContain('invalid-one');
    expect(output.error.message).toContain('invalid-two');
    expect(output.error.message.split('\n')).toHaveLength(2);
  });

  it('should name the missing module and exit non-zero when the isolated packed CLI import is missing', async () => {
    expect(packedBin).toBeDefined();
    const sourceRoot = dirname(dirname(await realpath(packedBin!)));
    const result = await withIsolatedCli(async (cwd, env) => {
      const cloneRoot = join(cwd, 'isolated-package');
      await cp(sourceRoot, cloneRoot, { recursive: true });
      await rm(join(cloneRoot, 'lib/cli/application.js'));

      return execa(
        execPath,
        [join(cloneRoot, 'bin/cli.mjs'), 'show', '--json', 'private-argument'],
        {
          cwd,
          env,
          extendEnv: false,
          reject: false,
          timeout: 2_000,
        },
      );
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ERR_MODULE_NOT_FOUND');
    expect(result.stderr).toContain('lib/cli/application.js');
    expect(result.stderr).not.toContain('private-argument');
  });

  it('should keep parser errors and emission ownership local to repeated CLI invocations', async () => {
    expect(packedBin).toBeDefined();
    const packageRoot = dirname(dirname(await realpath(packedBin!)));
    const cliUrl = pathToFileURL(
      join(packageRoot, 'lib/cli/application.js'),
    ).href;
    const source = `
      import { cli } from ${JSON.stringify(cliUrl)};
      await cli(['show', '--json', '--first-invalid']);
      await cli(['list', '--json', '--second-invalid']);
    `;
    const result = await withIsolatedCli(async (cwd, env) =>
      execa(execPath, ['--input-type=module', '-e', source], {
        cwd,
        env,
        extendEnv: false,
        reject: false,
        timeout: 2_000,
      }),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('');
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      schemaVersion: 1,
      command: 'show',
      ok: false,
      error: {
        code: 'USAGE',
        message: expect.stringContaining('--first-invalid'),
      },
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({
      schemaVersion: 1,
      command: 'list',
      ok: false,
      error: {
        code: 'USAGE',
        message: expect.stringContaining('--second-invalid'),
      },
    });
    expect(lines[1]).not.toContain('--first-invalid');
  });

  it('should keep a human parser failure off stdout', async () => {
    expect(packedBin).toBeDefined();
    const result = await withIsolatedCli(async (cwd, env) =>
      execa(packedBin!, ['show', '--invalid-human-flag'], {
        cwd,
        env,
        extendEnv: false,
        reject: false,
        timeout: 2_000,
      }),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--invalid-human-flag');
  });

  it('should separate unknown parser flags from an unreadable selected env file', async () => {
    expect(packedBin).toBeDefined();
    const [unknownFlag, missingEnv] = await withIsolatedCli(async (cwd, env) =>
      Promise.all([
        execa(packedBin!, ['show', '--json', '--unknown-flag'], {
          cwd,
          env,
          extendEnv: false,
          reject: false,
          timeout: 2_000,
        }),
        execa(
          packedBin!,
          ['show', '--json', '--env-file', join(cwd, 'absent.env')],
          {
            cwd,
            env,
            extendEnv: false,
            reject: false,
            timeout: 2_000,
          },
        ),
      ]),
    );

    expect(unknownFlag.exitCode).toBe(2);
    expect(JSON.parse(unknownFlag.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'show',
      ok: false,
      error: { code: 'USAGE' },
    });
    expect(unknownFlag.stdout.trim().split('\n')).toHaveLength(1);
    expect(unknownFlag.stderr).toBe('');
    expect(missingEnv.exitCode).toBe(1);
    expect(JSON.parse(missingEnv.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'show',
      ok: false,
      error: { code: 'INPUT' },
    });
    expect(missingEnv.stdout.trim().split('\n')).toHaveLength(1);
    expect(missingEnv.stderr).toContain('environment: started');
    expect(missingEnv.stderr).toContain('environment: failed');
  });

  it('should reject the removed --env flag like any unknown flag', async () => {
    expect(packedBin).toBeDefined();
    const result = await withIsolatedCli(async (cwd, env) =>
      execa(packedBin!, ['show', '--json', '--env', join(cwd, 'absent.env')], {
        cwd,
        env,
        extendEnv: false,
        reject: false,
        timeout: 2_000,
      }),
    );

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'show',
      ok: false,
      error: { code: 'USAGE' },
    });
    expect(result.stderr).toBe('');
  });

  it('should preserve CLI arguments and shows command-specific help', async () => {
    expect(packedBin).toBeDefined();
    const result = await withIsolatedCli(async (cwd, env) =>
      execa(packedBin!, ['show', '--help'], {
        cwd,
        env,
        extendEnv: false,
        reject: false,
        timeout: 10_000,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('show [<workstation>]');
    expect(result.stdout).toContain('--inspect');
    expect(result.stdout).toContain('--no-local-credentials');
  });

  it.each([['create'], ['setup']])(
    'should list the update due interval and no check interval in %s help',
    async (command) => {
      expect(packedBin).toBeDefined();
      const result = await withIsolatedCli(async (cwd, env) =>
        execa(packedBin!, [command, '--help'], {
          cwd,
          env,
          extendEnv: false,
          reject: false,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('--update-check-minutes');
      expect(result.stdout).toContain('--update-due-days');
    },
  );

  it('should show an optional workstation and a parsed value in setup usage', async () => {
    expect(packedBin).toBeDefined();
    const result = await withIsolatedCli(async (cwd, env) =>
      execa(packedBin!, ['setup', '--help'], {
        cwd,
        env,
        extendEnv: false,
        reject: false,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      'setup [<workstation>] [--section SECTION]',
    );
    expect(result.stdout).toContain('[--env-file]');
    expect(result.stdout).toContain('FILE · explicit env file');
    expect(result.stdout).toContain('ARGUMENTS\n  [workstation]');
  });

  it.each([['--help'], ['--version']] as const)(
    'should print %s without provider authentication',
    async (flag) => {
      expect(packedBin).toBeDefined();
      const result = await withIsolatedCli(async (cwd, env) =>
        execa(packedBin!, [flag], {
          cwd,
          env,
          extendEnv: false,
          reject: false,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain('Sprites API token');
      if (flag === '--help') {
        expect(result.stdout.indexOf('COMMANDS')).toBeLessThan(
          result.stdout.indexOf('ENVIRONMENT'),
        );
        expect(result.stdout.indexOf('ENVIRONMENT')).toBeLessThan(
          result.stdout.indexOf('LEARN MORE'),
        );
      } else {
        const version = result.stdout.trim().split('.');
        expect(version).toHaveLength(3);
        expect(
          version.every(
            (part) => part !== '' && Number.isInteger(Number(part)),
          ),
        ).toBe(true);
      }
    },
  );

  it('should suggest a kebab-case correction in human and JSON errors', async () => {
    expect(packedBin).toBeDefined();
    const [human, json] = await withIsolatedCli(async (cwd, env) =>
      Promise.all([
        execa(packedBin!, ['show', '--non-interactve'], {
          cwd,
          env,
          extendEnv: false,
          reject: false,
        }),
        execa(packedBin!, ['show', '--non-interactve', '--json'], {
          cwd,
          env,
          extendEnv: false,
          reject: false,
        }),
      ]),
    );

    expect(human.exitCode).toBe(2);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain('did you mean --non-interactive?');
    expect(human.stderr).not.toContain('--nonInteractive');
    expect(json.exitCode).toBe(2);
    expect(json.stderr).toBe('');
    expect(json.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'show',
      ok: false,
      error: {
        code: 'USAGE',
        message: expect.stringContaining('did you mean --non-interactive?'),
      },
    });
    expect(json.stdout).not.toContain('--nonInteractive');
  });

  it.each(['--help', '--version'])(
    'should reject --json with %s as one usage result before authentication',
    async (flag) => {
      expect(packedBin).toBeDefined();
      const result = await withIsolatedCli(async (cwd, env) =>
        execa(packedBin!, ['show', '--json', flag], {
          cwd,
          env,
          extendEnv: false,
          reject: false,
        }),
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        command: 'show',
        ok: false,
        error: {
          code: 'USAGE',
          message: expect.stringContaining('--json cannot be combined'),
        },
      });
      expect(result.stdout).not.toContain('Sprites API token');
    },
  );

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'should flush one cancellation result for OS %s while a request hangs',
    async (signal) => {
      expect(packedBin).toBeDefined();
      const result = await withIsolatedCli(async (cwd, env) => {
        const child = execa(
          execPath,
          [
            '--import',
            hangingFetch,
            packedBin!,
            'show',
            'open-agent-review-check',
            '--json',
          ],
          {
            cwd,
            env: { ...env, SPRITES_TOKEN: 'offline-placeholder' },
            extendEnv: false,
            reject: false,
            timeout: 30_000,
          },
        );
        await waitForOutput(child.stderr, HANGING_FETCH_MARKER);
        child.kill(signal);

        return child;
      });

      expect(result.exitCode).toBe(130);
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        command: 'show',
        ok: false,
        error: { code: 'CANCELLED', machine: 'open-agent-review-check' },
      });
    },
  );

  it('should force exit on the second interrupt during final flush', async () => {
    expect(packedBin).toBeDefined();
    const result = await withIsolatedCli(async (cwd, env) => {
      const child = execa(
        execPath,
        [
          '--import',
          hangingFetch,
          '--import',
          heldFlush,
          packedBin!,
          'show',
          'open-agent-review-check',
          '--json',
        ],
        {
          cwd,
          env: { ...env, SPRITES_TOKEN: 'offline-placeholder' },
          extendEnv: false,
          reject: false,
          timeout: 30_000,
        },
      );
      await waitForOutput(child.stderr, HANGING_FETCH_MARKER);
      child.kill('SIGINT');
      await waitForOutput(child.stdout, FLUSH_WAIT_MARKER);
      const secondInterrupt = performance.now();
      child.kill('SIGINT');
      const exit = await child;

      return { exit, elapsedMs: performance.now() - secondInterrupt };
    });

    expect(result.exit.exitCode).toBe(130);
    expect(result.elapsedMs).toBeLessThan(500);
    expect(result.exit.stdout).toContain(FLUSH_WAIT_MARKER);
    expect(result.exit.stdout.match(/"code":"CANCELLED"/gu)).toHaveLength(1);
    expect(result.exit.stdout).toContain('open-agent-review-check');
  });
});
