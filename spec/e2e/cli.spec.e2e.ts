import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  cp,
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

import { runTerminal } from '../fixtures/terminal.js';

const packedBin = process.env.AGENT_SPRITE_PACKED_BIN;
const pendingConnection =
  'data:text/javascript,' +
  encodeURIComponent(
    'import {createServer} from "node:net"; createServer().listen(0,"127.0.0.1");',
  );
const heldFlush =
  'data:text/javascript,' +
  encodeURIComponent(`
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, encoding, callback) => {
      if (chunk !== '') return write(chunk, encoding, callback);
      write('[SAF05:FLUSH_WAIT]\\n');
      const done = typeof encoding === 'function' ? encoding : callback;
      setTimeout(() => done?.(), 1000);
      return true;
    };
  `);

async function withIsolatedCli<T>(
  run: (cwd: string, env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-sprite-e2e-'));
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
      'tailscale',
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

  it.each(['create', 'setup', 'show'])(
    'should accept explicit pairing on %s before missing-token INPUT',
    async (command) => {
      expect(packedBin).toBeDefined();
      const result = await withIsolatedCli(async (cwd, env) =>
        execa(
          packedBin!,
          [command, '--json', '--with-t3-pair-code', '--no-local-credentials'],
          { cwd, env, extendEnv: false, reject: false },
        ),
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
          [command, ...args, '--json', '--env', join(cwd, 'missing.env')],
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
      runTerminal(packedBin!, [], {
        args: ['terminate', '--env', join(cwd, 'missing.env')],
        cwd,
        env: { ...env, CI: 'true' },
      }),
    );

    expect(result.timedOut).toBe(false);
    expect(result.matchedSteps).toBe(0);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('exact workstation name and --yes');
    expect(result.output).not.toContain('missing.env');
    expect(result.output).not.toContain('Sprites API token');
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
          [...args, '--json', '--env', join(cwd, 'missing.env')],
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
          expect.stringContaining('SPRITES_TOKEN or pass --env FILE'),
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
            '--sprites-token-source',
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

  it('should identify an unreadable selected --env file without exposing its raw read failure', async () => {
    expect(packedBin).toBeDefined();
    const result = await withIsolatedCli(async (cwd, env) =>
      execa(
        packedBin!,
        [
          'list',
          '--json',
          '--no-local-credentials',
          '--env',
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
    expect(outputs[2].stdout).toContain('agent-sprite');
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
          '--env',
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
          '--no-tailscale',
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

  it('should print verbose facts during a real Ink token prompt and cancellation', async () => {
    expect(packedBin).toBeDefined();
    const result = await withIsolatedCli(async (cwd, env) =>
      runTerminal(
        packedBin!,
        [{ waitFor: 'Sprites API token', input: '\x03' }],
        {
          args: [
            'show',
            'agent-sprite-review-check',
            '--verbose',
            '--no-local-credentials',
          ],
          cwd,
          env,
        },
      ),
    );

    expect(result.timedOut).toBe(false);
    expect(result.matchedSteps).toBe(1);
    expect(result.exitCode).toBe(130);
    expect(result.output).toContain('[verbose] stage=command event=start');
    expect(result.output).toContain('Cancelled by user.');
    expect(result.output).not.toContain('^C');
  });

  it('should print help through the installed bin on a native terminal', async () => {
    expect(packedBin).toBeDefined();
    const result = await withIsolatedCli(async (cwd, env) =>
      runTerminal(packedBin!, [], { args: ['--help'], cwd, env }),
    );

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('agent-sprite');
    expect(result.output).toContain('terminate');
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
    expect(result.stdout).toContain('agent-sprite');
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
        details: [expect.stringContaining('Sprite deletion completed')],
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

  it('should emit one safe JSON failure when the isolated packed CLI import is missing', async () => {
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
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'show',
      ok: false,
      error: { code: 'UNEXPECTED', message: 'The command could not start.' },
    });
    expect(result.stdout).not.toContain('private-argument');
    expect(result.stdout).not.toContain('Error:');
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
          ['show', '--json', '--env', join(cwd, 'absent.env')],
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
    expect(result.stdout).toContain('[--env]');
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

  it('should show the real token prompt and responds to Ctrl-C', async () => {
    expect(packedBin).toBeDefined();
    const result = await withIsolatedCli(async (cwd, env) =>
      runTerminal(
        packedBin!,
        [{ waitFor: 'Sprites API token', input: '\x03' }],
        {
          args: ['show', 'agent-sprite-review-check', '--no-local-credentials'],
          cwd,
          env,
        },
      ),
    );

    expect(result.timedOut).toBe(false);
    expect(result.matchedSteps, result.output).toBe(1);
    expect(result.output).toContain('Sprites API token');
    expect(result.output).toContain('https://sprites.dev/account');
    expect(result.output).toContain('intended organization');
    expect(result.exitCode).toBe(130);
    expect(result.output).toContain('Cancelled by user.');
    expect(result.output).not.toContain('^C');
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'should flush one cancellation result for OS %s at the real token prompt',
    async (signal) => {
      expect(packedBin).toBeDefined();
      const result = await withIsolatedCli(async (cwd, env) =>
        runTerminal(packedBin!, [{ waitFor: 'Sprites API token', signal }], {
          args: ['show', 'agent-sprite-review-check', '--no-local-credentials'],
          cwd,
          env,
        }),
      );

      expect(result.timedOut).toBe(false);
      expect(result.matchedSteps, result.output).toBe(1);
      expect(result.exitCode).toBe(130);
      expect(result.output).toContain('Cancelled by user.');
      expect(result.output).toContain('agent-sprite-review-check');
      expect(result.output).not.toContain('^C');
      expect(result.output.match(/Cancelled by user\./gu)).toHaveLength(1);
    },
  );

  it('should force exit on the second physical interrupt during final flush', async () => {
    expect(packedBin).toBeDefined();
    const result = await withIsolatedCli(async (cwd, env) =>
      runTerminal(
        execPath,
        [
          { waitFor: 'Sprites API token', input: '\x03' },
          { waitFor: '[SAF05:FLUSH_WAIT]', signal: 'SIGINT' },
        ],
        {
          args: [
            '--import',
            heldFlush,
            packedBin!,
            'show',
            'agent-sprite-review-check',
            '--no-local-credentials',
          ],
          cwd,
          env,
        },
      ),
    );

    expect(result.timedOut).toBe(false);
    expect(result.matchedSteps, result.output).toBe(2);
    expect(result.exitCode).toBe(130);
    expect(result.elapsedMs - result.stepTimes[1]!).toBeLessThan(500);
    expect(result.output).toContain('[SAF05:FLUSH_WAIT]');
    expect(result.output.match(/Cancelled by user\./gu)).toHaveLength(1);
    expect(result.output).toContain('agent-sprite-review-check');
    expect(result.output).not.toContain('^C');
  });
});
