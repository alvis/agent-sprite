import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, constants } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'dotenv';

import { drainProcessGroup, signalGroup } from './process-group.js';

/** child exit state with its process group leader */
interface ChildExit {
  /** exit code */
  code: number | null;
  /** native terminating signal */
  signal: NodeJS.Signals | null;
  /** process group leader */
  pid?: number;
}

/** the live test projects: every provider's suite, and the Fly Machine probe */
type LiveProject = 'LIVE' | 'LIVE-FLY';

/** validated live-run selection passed to a live test project */
interface LiveRun {
  /** absolute dotenv path read by the live harness */
  envFile: string;
  /** selected workstation provider */
  provider: string;
  /** unique workstation name prefix owned by this run */
  runId: string;
  /** whether only the cleanup sweep should run */
  sweep: boolean;
  /** live test project the run executes */
  project: LiveProject;
}

/** options for one spawned child process */
interface RunOptions {
  /** working directory */
  cwd?: string;
  /** child environment */
  env: Record<string, string | undefined>;
  /** whether stdout is forwarded to stderr */
  preparation?: boolean;
}

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ARGUMENTS_START_INDEX = 3;
const DELIMITER_ARGUMENTS_START_INDEX = 4;
const SIGNAL_EXIT_BASE = 128;
const REFUSAL_STATUS = 2;
const LIVE_TEARDOWN_TIMEOUT_MS = 1_800_000; // 30 minutes for the cleanup sweep
const LIVE_RUN_ID_BYTES = 4;
const LIVE_RUN_PREFIX = 'oa-live';
const LIVE_RUN_ID = new RegExp(`^${LIVE_RUN_PREFIX}-[0-9a-f]{8}$`);
const PROJECT = 'open-agent';
const ENVIRONMENT_PREFIX = 'OPEN_AGENT';
/** terminal shutdown signals forwarded to the child process group */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
/** live modes and the test project each runs */
const LIVE_MODES: Readonly<Record<string, LiveProject>> = {
  'test:live': 'LIVE',
  'test:live:fly': 'LIVE-FLY',
};
const MODES = ['run', 'test:e2e', ...Object.keys(LIVE_MODES)];
/** the provider whose credential the Fly Machine probe needs as well */
const FLY_PROVIDER = 'fly-machine';
const mode = process.argv[2];
const arguments_ =
  process.argv[ARGUMENTS_START_INDEX] === '--'
    ? process.argv.slice(DELIMITER_ARGUMENTS_START_INDEX)
    : process.argv.slice(ARGUMENTS_START_INDEX);
let interrupted = false;

/**
 * runs the requested command against a freshly packed installation
 * @returns resolves after execution and cleanup
 */
async function main(): Promise<void> {
  if (mode === undefined || !MODES.includes(mode)) {
    throw new Error(`Expected one of ${MODES.join(', ')} modes`);
  }
  const liveProject = LIVE_MODES[mode];
  const live = liveProject ? await selectLiveRun(liveProject) : undefined;
  if (live === null) {
    return;
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), `${PROJECT}-packed-`));
  const tarball = join(temporaryRoot, `${PROJECT}.tgz`);
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

    const bin = join(prefix, 'node_modules', '.bin', PROJECT);
    if (mode === 'run') {
      process.exitCode = exitStatus(
        await run(bin, arguments_, { env: process.env }),
      );
    } else if (live) {
      process.exitCode = await runLive(bin, live);
    } else {
      process.exitCode = exitStatus(
        await runVitest('E2E', [], {
          [`${ENVIRONMENT_PREFIX}_PACKED_BIN`]: bin,
        }),
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * validates the live dotenv credentials before any build or provider work
 * @param project live test project the run executes
 * @returns live selection, or null after a refusal
 */
async function selectLiveRun(project: LiveProject): Promise<LiveRun | null> {
  const envFile = resolve(
    process.env[`${ENVIRONMENT_PREFIX}_LIVE_ENV`] ?? '.env',
  );
  const provider =
    process.env[`${ENVIRONMENT_PREFIX}_LIVE_PROVIDER`] ?? 'sprite';
  const credentials = await providerCredentials();
  const credential = credentials.get(provider);
  const flyCredential = credentials.get(FLY_PROVIDER);
  if (!credential || !flyCredential) {
    return refuse(
      `${mode} does not support provider ${provider}; expected ${[...credentials.keys()].join(', ')}`,
    );
  }
  const values = await readFile(envFile, 'utf8').then(parse, () => undefined);
  if (!values) {
    return refuse(
      `${mode} requires the dotenv file ${envFile}; set ${ENVIRONMENT_PREFIX}_LIVE_ENV to select another`,
    );
  }
  if (!values[credential]?.trim()) {
    return refuse(
      `${mode} requires ${credential} in ${envFile} for the ${provider} provider`,
    );
  }
  if (project === 'LIVE-FLY' && !values[flyCredential]?.trim()) {
    return refuse(
      `${mode} requires ${flyCredential} in ${envFile} for the Fly Machine probe`,
    );
  }
  const sweep = process.env[`${ENVIRONMENT_PREFIX}_LIVE_SWEEP`] === '1';
  const requestedRunId = process.env[`${ENVIRONMENT_PREFIX}_LIVE_RUN_ID`];
  if (requestedRunId !== undefined && !LIVE_RUN_ID.test(requestedRunId)) {
    return refuse(
      `${ENVIRONMENT_PREFIX}_LIVE_RUN_ID must match ${LIVE_RUN_PREFIX}-<8 hex digits>`,
    );
  }
  if (sweep && !requestedRunId) {
    return refuse(
      `${ENVIRONMENT_PREFIX}_LIVE_SWEEP=1 requires ${ENVIRONMENT_PREFIX}_LIVE_RUN_ID`,
    );
  }

  return {
    envFile,
    provider,
    runId:
      requestedRunId ??
      `${LIVE_RUN_PREFIX}-${randomBytes(LIVE_RUN_ID_BYTES).toString('hex')}`,
    sweep,
    project,
  };
}

/**
 * reads provider credential names from the source catalog before any build
 * @returns provider id to the environment name of its management credential
 */
async function providerCredentials(): Promise<Map<string, string>> {
  const { catalog } = await import('#core/catalog');

  return new Map(
    Object.entries(catalog.providers).map(([id, { prerequisites }]) => [
      id,
      prerequisites.credential.environment,
    ]),
  );
}

/**
 * reports a refused live run without starting any child process
 * @param message actionable refusal reason without secret values
 * @returns marker for a refused run
 */
function refuse(message: string): null {
  process.stderr.write(`[packed-cli] ${message}\n`);
  process.exitCode = REFUSAL_STATUS;

  return null;
}

/**
 * runs a live project, then sweeps the run prefix again unless it finished cleanly
 * @param bin installed executable path
 * @param live validated live selection
 * @returns process status to return
 */
async function runLive(bin: string, live: LiveRun): Promise<number> {
  const environment = {
    [`${ENVIRONMENT_PREFIX}_PACKED_BIN`]: bin,
    [`${ENVIRONMENT_PREFIX}_LIVE_ENV`]: live.envFile,
    [`${ENVIRONMENT_PREFIX}_LIVE_PROVIDER`]: live.provider,
    [`${ENVIRONMENT_PREFIX}_LIVE_RUN_ID`]: live.runId,
  };
  const options = [`--teardownTimeout=${LIVE_TEARDOWN_TIMEOUT_MS}`];
  const sweep = async (): Promise<number> =>
    exitStatus(
      await runVitest(live.project, [...options, '--testNamePattern=^$'], {
        ...environment,
        [`${ENVIRONMENT_PREFIX}_LIVE_SWEEP`]: '1',
      }),
    );
  process.stderr.write(
    `[packed-cli] live ${live.sweep ? 'sweep' : 'run'} ${live.runId} (${live.project}, ${live.provider})\n`,
  );
  if (live.sweep) {
    return sweep();
  }

  const result = await runVitest(live.project, options, environment);
  const status = exitStatus(result);
  if (status === 0 && !interrupted) {
    return status;
  }
  // vitest skips global teardown on interruption, unhandled rejection or teardown timeout
  await drainProcessGroup(result.pid);
  process.stderr.write(
    `[packed-cli] live run ${live.runId} did not finish cleanly; sweeping its workstations again\n`,
  );
  if ((await sweep()) !== 0) {
    process.stderr.write(
      `[packed-cli] sweep failed; retry with ${ENVIRONMENT_PREFIX}_LIVE_RUN_ID=${live.runId} ${ENVIRONMENT_PREFIX}_LIVE_SWEEP=1 pnpm ${mode}\n`,
    );
  }

  return status;
}

/**
 * runs one vitest project against the packed installation
 * @param project project suffix
 * @param options vitest options placed before caller arguments
 * @param environment additional child environment
 * @returns child exit state
 */
async function runVitest(
  project: 'E2E' | LiveProject,
  options: string[],
  environment: Record<string, string>,
): Promise<ChildExit> {
  return run(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--project',
      `${PROJECT}:${project}`,
      ...options,
      ...arguments_,
    ],
    { env: { ...process.env, ...environment } },
  );
}

/**
 * runs a preparation command from the project root
 * @param command executable to run
 * @param args command arguments
 * @returns child exit state
 */
async function prepare(command: string, args: string[]): Promise<ChildExit> {
  process.stderr.write(`[packed-cli] ${command} ${args[0]}\n`);

  return run(command, args, {
    cwd: projectRoot,
    env: process.env,
    preparation: true,
  });
}

/**
 * retains a failed preparation status for process exit
 * @param result child exit state
 * @returns whether preparation failed
 */
function recordFailure(result: ChildExit): boolean {
  const status = exitStatus(result);

  if (status === 0) {
    return false;
  }
  process.exitCode = status;

  return true;
}

/**
 * maps an exit signal or code to the process status
 * @param result child exit state
 * @returns status to return to the caller
 */
function exitStatus(result: ChildExit): number {
  return result.signal
    ? SIGNAL_EXIT_BASE + constants.signals[result.signal]
    : (result.code ?? 1);
}

/**
 * runs a child process and forwards termination signals
 * @param command executable to run
 * @param args command arguments
 * @param options child process options
 * @param options.cwd working directory
 * @param options.env child environment
 * @param options.preparation whether stdout is forwarded to stderr
 * @returns child exit state
 */
async function run(
  command: string,
  args: string[],
  { cwd = process.cwd(), env, preparation = false }: RunOptions,
): Promise<ChildExit> {
  return new Promise<ChildExit>((resolveResult, reject): void => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      env,
      stdio: ['inherit', preparation ? 'pipe' : 'inherit', 'inherit'],
    });
    if (preparation) {
      child.stdout?.pipe(process.stderr);
    }
    /**
     * forwards terminal shutdown to the child process group
     * @param signal shutdown signal
     */
    const forward = (signal: (typeof SHUTDOWN_SIGNALS)[number]): void => {
      interrupted = true;
      if (child.pid) {
        signalGroup(child.pid, signal);
      }
    };
    for (const signal of SHUTDOWN_SIGNALS) {
      process.on(signal, forward);
    }
    /** removes signal handlers after child settlement */
    const release = (): void => {
      for (const signal of SHUTDOWN_SIGNALS) {
        process.off(signal, forward);
      }
    };
    child.once('error', (error): void => {
      release();
      reject(error);
    });
    child.once('exit', (code, signal): void => {
      release();
      resolveResult({ code, signal, pid: child.pid });
    });
  });
}

main().catch((error: unknown): void => {
  const failure = error as Error;
  process.stderr.write(`[packed-cli] ${failure.message}\n`);
  process.exitCode = 1;
});
