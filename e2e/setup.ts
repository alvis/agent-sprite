import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from 'dotenv';
import { execa, execaSync } from 'execa';

import { FLYCTL } from '#adapters/drivers/providers/fly-machine/flyctl';

import {
  cleanUpBestEffort,
  connectRunAccounts,
  createMachineCleanup,
  MANUAL_CHECK,
} from './machines/cleanup';
import { createMachineCli, driverConfigHome, tail } from './machines/cli';
import { E2E_NAME_PREFIX, PRODUCT, TEST_PREFIX } from './machines/identity';
import { createRedactor } from './machines/redaction';

import type { TestProject } from 'vitest/node';

import type { Redactor } from './machines/redaction';

declare module 'vitest' {
  /** values e2e/setup.ts provides to every e2e spec */
  export interface ProvidedContext {
    /** the open-agent executable installed from this checkout's packed tarball */
    packedBin: string;
    /** this run's id, `oa-e2e-` and eight hex digits, the prefix of every workstation it creates */
    runId: string;
    /** the run's isolated home: the CLI's HOME and the root of every run file */
    runHome: string;
  }
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
/**
 * prefix of the run home: short on purpose, because flyctl's agent binds a
 * Unix socket below it (`.config/open-agent/flyctl/fly-agent.sock`, 41
 * characters), and macOS accepts at most 103 characters of socket path, which
 * a temporary directory of 50 characters plus a long prefix exceeds
 */
const HOME_PREFIX = 'oa-';
const RUN_ID_BYTES = 4;
/**
 * the run's cleanup, at teardown or on a signal, sends its deletions and
 * looks for their effect this long, inside vitest's default teardown window
 * of 10 seconds
 */
const CLEANUP_LIMIT_MS = 7_000;
/** everything an interruption does, cleanup to home removal, ends within this */
const INTERRUPT_LIMIT_MS = 10_000;
/** what starting the child process of an interrupted run's cleanup may take */
const CHILD_STARTUP_MS = 1_500;
/** the longest one `fly agent stop` may take */
const AGENT_STOP_MS = 1_000;
/** and all of them together, after the cleanup */
const AGENT_STOPS_MS = 2_000;
/** exit code of a run its terminal hung up on */
const HANGUP_EXIT_CODE = 129;
/**
 * vitest answers SIGINT and SIGTERM itself, by exiting on a timer; SIGHUP it
 * leaves to Node, whose default exit a listener replaces
 */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
/** where the child process of an interrupted run's cleanup loads its code from */
const CLEANUP_MODULE = '/e2e/machines/cleanup.ts';
/**
 * the child process of an interrupted run's cleanup: loads the TypeScript
 * cleanup through vitest's own Vite, runs it and exits, whatever requests are
 * still open
 */
const CLEANUP_BOOTSTRAP = `
import { createViteServer } from 'vitest/node';
const [, modulePath, input] = process.argv;
const server = await createViteServer({
  configFile: false,
  root: process.cwd(),
  logLevel: 'silent',
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const { cleanUpInterruptedRun } = await server.ssrLoadModule(modulePath);
await cleanUpInterruptedRun(input);
process.exit(0);
`;

/**
 * publishes this checkout as a user would install it, sweeps what earlier runs
 * left behind, and returns the teardown that deletes whatever this run left
 * @param project the e2e project receiving the run's values
 * @returns teardown deleting the run's workstations and removing its home
 */
export async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  // a value already in the environment wins over the file
  config({ path: join(projectRoot, '.env.test'), quiet: true });
  const redact = createRedactor(process.env);
  const runHome = await mkdtemp(join(tmpdir(), HOME_PREFIX));
  try {
    const packedBin = await installPackedPublication(runHome, redact);
    const runId = `${E2E_NAME_PREFIX}${randomBytes(RUN_ID_BYTES).toString('hex')}`;
    const scope = `${runId}-`;
    // the workers, which inherit this, import the product's drivers
    // in-process; their flyctl state must not be the owner's
    process.env.XDG_CONFIG_HOME = driverConfigHome(runHome);

    // with no provider token nothing is swept and no provider is called
    const accounts = connectRunAccounts(redact);
    if (accounts) {
      process.stderr.write(
        `[e2e] start sweep: deleting every ${E2E_NAME_PREFIX}* workstation and tailnet device these credentials reach, whichever run left it\n`,
      );
      await createMachineCleanup({
        cli: createMachineCli({ bin: packedBin, home: runHome, redact }),
        ...accounts,
        scope: E2E_NAME_PREFIX,
        redact,
      }).sweep();
    }

    const interrupt = (signal: NodeJS.Signals): void => {
      for (const shutdown of SHUTDOWN_SIGNALS) {
        process.off(shutdown, interrupt);
      }
      interruptRun({ runHome, scope, signal, hasAccounts: Boolean(accounts) });
    };
    for (const signal of SHUTDOWN_SIGNALS) {
      process.once(signal, interrupt);
    }

    project.provide('packedBin', packedBin);
    project.provide('runId', runId);
    project.provide('runHome', runHome);

    return async () => {
      for (const signal of SHUTDOWN_SIGNALS) {
        process.off(signal, interrupt);
      }
      try {
        if (accounts) {
          await cleanUpBestEffort(accounts, {
            scope,
            limitMs: CLEANUP_LIMIT_MS,
            redact,
          });
        }
      } finally {
        stopFlyctlAgents(runHome, Date.now() + AGENT_STOPS_MS);
        await rm(runHome, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(runHome, { recursive: true, force: true });
    throw error;
  }
}

/**
 * builds this checkout, packs it with pnpm and installs the tarball with npm
 * into the run home, exactly as a user installs a publication
 * @param runHome the run's isolated home
 * @param redact removes credential values from a failure's output
 * @returns the installed executable
 */
async function installPackedPublication(
  runHome: string,
  redact: Redactor,
): Promise<string> {
  const prefix = join(runHome, 'package');
  const tarball = join(prefix, `${PRODUCT}.tgz`);
  await mkdir(prefix);
  await prepare('pnpm', ['run', 'build'], redact);
  await prepare('pnpm', ['pack', '--out', tarball], redact);
  await prepare(
    'npm',
    [
      'install',
      '--prefix',
      prefix,
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarball,
    ],
    redact,
  );

  return join(prefix, 'node_modules', '.bin', PRODUCT);
}

/**
 * runs one preparation command from the project root, without the `TEST_*`
 * credentials, which no build or install needs
 * @param command executable to run
 * @param args command arguments
 * @param redact removes credential values from a failure's output
 * @throws {Error} with the end of its output when the command fails
 */
async function prepare(
  command: string,
  args: string[],
  redact: Redactor,
): Promise<void> {
  const result = await execa(command, args, {
    cwd: projectRoot,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith(TEST_PREFIX),
      ),
    ),
    extendEnv: false,
    all: true,
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (exit ${result.exitCode}):\n${redact(tail(result.all))}`,
    );
  }
}

/**
 * deletes what an interrupted run left, best effort. vitest answers SIGINT
 * and SIGTERM by exiting on a timer without global teardown, so this runs
 * entirely synchronously, under one deadline: the cleanup runs in a child
 * process, which may wait on requests where this one may only block, then
 * the flyctl agents stop and the run home goes. On SIGHUP, which vitest
 * leaves alone, it exits itself.
 * @param run the run's home, scope, signal and whether it has provider accounts
 * @param run.runHome the run's isolated home
 * @param run.scope the run's `<run id>-` scope
 * @param run.signal the signal that interrupted the run
 * @param run.hasAccounts false when no provider token is set and nothing
 * can have been created
 */
function interruptRun(run: {
  runHome: string;
  scope: string;
  signal: NodeJS.Signals;
  hasAccounts: boolean;
}): void {
  const { runHome, scope, signal, hasAccounts } = run;
  const deadline = Date.now() + INTERRUPT_LIMIT_MS;
  const timeout = deadline - AGENT_STOPS_MS - Date.now();
  const cleanup =
    hasAccounts &&
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        CLEANUP_BOOTSTRAP,
        CLEANUP_MODULE,
        JSON.stringify({ scope, limitMs: timeout - CHILD_STARTUP_MS, signal }),
      ],
      {
        cwd: projectRoot,
        env: process.env,
        stdio: ['ignore', 'ignore', 'inherit'],
        timeout,
        killSignal: 'SIGKILL',
      },
    );
  if (cleanup && cleanup.status !== 0) {
    process.stderr.write(
      `[e2e] the cleanup after ${signal} did not finish; this run's ${scope}* workstations may remain: ${MANUAL_CHECK}\n`,
    );
  }
  stopFlyctlAgents(runHome, deadline);
  rmSync(runHome, { recursive: true, force: true });
  if (signal === 'SIGHUP') {
    process.exit(process.exitCode ?? HANGUP_EXIT_CODE);
  }
}

/**
 * stops the flyctl agent of every configuration home of the run: the CLI's,
 * each isolated CLI's and the in-process drivers'; an agent holds a token
 * @param runHome the run's isolated home
 * @param deadline epoch milliseconds the stops must end by
 */
function stopFlyctlAgents(runHome: string, deadline: number): void {
  const homes = [
    runHome,
    ...(existsSync(runHome)
      ? readdirSync(runHome, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(runHome, entry.name))
      : []),
  ];
  for (const home of homes) {
    const directory = join(home, '.config', PRODUCT, 'flyctl');
    // a zero timeout would be none at all
    const timeout = Math.min(AGENT_STOP_MS, deadline - Date.now());
    if (timeout <= 0) {
      return;
    }
    if (existsSync(directory)) {
      // the driver's own flyctl, environment and stop; it needs no token
      execaSync(FLYCTL, ['agent', 'stop'], {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: runHome,
          FLY_CONFIG_DIR: directory,
          FLY_NO_UPDATE_CHECK: '1',
        },
        extendEnv: false,
        stdio: 'ignore',
        timeout,
        killSignal: 'SIGKILL',
        reject: false,
      });
    }
  }
}
