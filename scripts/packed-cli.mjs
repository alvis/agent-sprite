import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, constants } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @import { ChildProcess } from 'node:child_process' */

/**
 * native child termination signal
 * @typedef {ChildProcess['signalCode']} ChildSignal
 */

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ARGUMENTS_START_INDEX = 3;
const DELIMITER_ARGUMENTS_START_INDEX = 4;
const SIGNAL_EXIT_BASE = 128;
const mode = process.argv[2];
const arguments_ =
  process.argv[ARGUMENTS_START_INDEX] === '--'
    ? process.argv.slice(DELIMITER_ARGUMENTS_START_INDEX)
    : process.argv.slice(ARGUMENTS_START_INDEX);

/**
 * runs the requested command against a freshly packed installation
 * @returns {Promise<void>} resolves after execution and cleanup
 */
async function main() {
  if (mode !== 'run' && mode !== 'test:e2e') {
    throw new Error('Expected run or test:e2e mode');
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-sprite-packed-'));
  const tarball = join(temporaryRoot, 'agent-sprite.tgz');
  const prefix = join(temporaryRoot, 'installed');

  try {
    const build = await prepare('pnpm', ['run', 'build']);
    if (recordFailure(build)) {
      return;
    }
    const pack = await prepare('pnpm', ['pack', '--out', tarball]);
    if (recordFailure(pack)) {
      return;
    }
    const install = await prepare('npm', [
      'install',
      '--prefix',
      prefix,
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarball,
    ]);
    if (recordFailure(install)) {
      return;
    }

    const bin = join(prefix, 'node_modules', '.bin', 'agent-sprite');
    const command = mode === 'run' ? bin : 'pnpm';
    const args =
      mode === 'run'
        ? arguments_
        : [
            'exec',
            'vitest',
            'run',
            '--project',
            'agent-sprite:E2E',
            ...arguments_,
          ];
    const environment =
      mode === 'run'
        ? process.env
        : { ...process.env, AGENT_SPRITE_PACKED_BIN: bin };
    const result = await run(command, args, { env: environment });
    process.exitCode = exitStatus(result);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * runs a preparation command from the project root
 * @param {string} command executable to run
 * @param {string[]} args command arguments
 * @returns {Promise<{code: number | null, signal: ChildSignal}>} child exit state
 */
async function prepare(command, args) {
  process.stderr.write(`[packed-cli] ${command} ${args[0]}\n`);

  return run(command, args, {
    cwd: projectRoot,
    env: process.env,
    preparation: true,
  });
}

/**
 * retains a failed preparation status for process exit
 * @param {{code: number | null, signal: ChildSignal}} result child exit state
 * @returns {boolean} whether preparation failed
 */
function recordFailure(result) {
  const status = exitStatus(result);

  if (status === 0) {
    return false;
  }
  process.exitCode = status;

  return true;
}

/**
 * maps an exit signal or code to the process status
 * @param {{code: number | null, signal: ChildSignal}} result child exit state
 * @returns {number} status to return to the caller
 */
function exitStatus(result) {
  return result.signal
    ? SIGNAL_EXIT_BASE + constants.signals[result.signal]
    : (result.code ?? 1);
}

/**
 * runs a child process and forwards termination signals
 * @param {string} command executable to run
 * @param {string[]} args command arguments
 * @param {object} root0 child process options
 * @param {string} [root0.cwd] working directory
 * @param {Record<string, string | undefined>} root0.env child environment
 * @param {boolean} [root0.preparation] whether stdout is forwarded to stderr
 * @returns {Promise<{code: number | null, signal: ChildSignal}>} child exit state
 */
async function run(
  command,
  args,
  { cwd = process.cwd(), env, preparation = false },
) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      env,
      stdio: ['inherit', preparation ? 'pipe' : 'inherit', 'inherit'],
    });
    if (preparation) {
      child.stdout.pipe(process.stderr);
    }
    /** @type {Array<'SIGINT' | 'SIGTERM' | 'SIGHUP'>} */
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    /**
     * forwards terminal shutdown to the child process group
     * @param {'SIGINT' | 'SIGTERM' | 'SIGHUP'} signal shutdown signal
     * @returns {void} completes after the signal is forwarded
     */
    const forward = (signal) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          const failure = /** @type {Error & {code?: string}} */ (error);
          if (failure.code !== 'ESRCH') {
            throw failure;
          }
        }
      }
    };
    for (const signal of signals) {
      process.on(signal, forward);
    }
    /**
     * removes signal handlers after child settlement
     * @returns {void} completes after handlers are released
     */
    const release = () => {
      for (const signal of signals) {
        process.off(signal, forward);
      }
    };
    child.once('error', (error) => {
      release();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      release();
      resolveResult({ code, signal });
    });
  });
}

main().catch((error) => {
  const failure = /** @type {Error} */ (error);
  process.stderr.write(`[packed-cli] ${failure.message}\n`);
  process.exitCode = 1;
});
