import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempDisposable,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';

import {
  packageRoot,
  packedPayloads,
  stage,
} from '../fixtures/packed-guest.js';

import type { ChildProcess } from 'node:child_process';

import type {
  ControlRequest,
  ControlResponse,
  SupervisedService,
} from '#guest/supervisor/protocol';

// the packaged proof of the guest supervisor: the packed host stages its
// kernel with its own worker, and each test runs the staged daemon as its own
// process over a temporary guest root, driving it through the staged client
// as the control entry does. The accounts start services without switching,
// and the trust check accepts the test account's files

const ROOT_ONLY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
/** a timer pass every fifth of a second, so a test sees several */
const TIMER_INTERVAL_MS = 200;
const REQUEST_WAIT_MS = 5_000;
const POLL_MS = 50;
const SLOW_TEST_MS = 30_000;

const packed = await packageRoot();
const staging = await mkdtempDisposable(join(tmpdir(), 'oa-sv-'));
const guestRoot = await realpath(staging.path);
await stage(packed, guestRoot, (await packedPayloads(packed)).frame);
const { requestSupervisor } = (await import(
  pathToFileURL(join(guestRoot, 'guest/supervisor/client.js')).href
)) as {
  requestSupervisor: (
    path: string,
    request: ControlRequest,
    waitMs: number,
  ) => Promise<ControlResponse>;
};

afterAll(async () => {
  await staging[Symbol.asyncDispose]();
});

/** the source of the process that runs the staged daemon */
const DAEMON_RUNNER = `
const params = JSON.parse(process.env.OA_DAEMON);
const { appendFile } = await import('node:fs/promises');
const { existsSync } = await import('node:fs');
const { runDaemon } = await import(params.daemon);
let ticks = 0;
const daemon = await runDaemon({
  ...params.options,
  now: Date.now,
  trust: async (path) => path,
  tick: async () => {
    ticks += 1;
    await appendFile(
      params.ticks,
      existsSync(params.updating) ? 'tick-during-update\\n' : 'tick\\n',
    );
    if (params.hangFirstTick && ticks === 1) {
      await new Promise(() => undefined);
    }
    const at = new Date().toISOString();
    return {
      diagnostics: ['fixture note'],
      ...(ticks === 1 && {
        adapter: { at, action: 'enter-idle-form', result: 'memory-suspend' },
      }),
    };
  },
});
process.once('SIGTERM', () => {
  void daemon.stop().then(() => process.exit(0));
});
process.stdout.write('ready\\n');
`;

/** what a test changes about the workstation's timer */
interface TimerOptions {
  /** builds the shell command of the update entry from the workstation's directory; it records a run by default */
  update?: (directory: string) => string;
  /** whether the first governed tick never ends */
  hangFirstTick?: boolean;
  /** how long a pass may run before the timer abandons it */
  passDeadlineMs?: number;
  /** how long a pass waits for the update entry to end */
  updateSettleMs?: number;
}

/** one temporary workstation the daemon supervises */
interface Workstation extends AsyncDisposable {
  /** the workstation's scratch directory, where services leave their marks */
  directory: string;
  /** starts the daemon over the workstation's directories */
  start: () => Promise<RunningDaemon>;
  /** reads the supervisor's log */
  log: () => Promise<string>;
}

/** a daemon process */
interface RunningDaemon {
  /** sends one control request */
  request: (request: ControlRequest) => Promise<ControlResponse>;
  /** asks the daemon to stop, as the init does, and waits for its exit */
  stop: () => Promise<number | null>;
}

/**
 * prepares a workstation's directories under the staged guest root
 * @param timer what the test changes about the timer
 * @returns its directory, its daemon starter and its log reader
 */
async function workstation(timer: TimerOptions = {}): Promise<Workstation> {
  const scratch = await mkdtempDisposable(join(tmpdir(), 'oa-ws-'));
  const directory = await realpath(scratch.path);
  const logPath = join(directory, 'supervisor.log');
  const environment = { PATH: '/usr/bin:/bin', LANG: 'C' };
  const running: ChildProcess[] = [];
  const params = {
    daemon: pathToFileURL(join(guestRoot, 'guest/supervisor/daemon.js')).href,
    ticks: join(directory, 'ticks'),
    updating: join(directory, 'updating'),
    hangFirstTick: timer.hangFirstTick ?? false,
    options: {
      stateDirectory: join(directory, 'state'),
      runDirectory: join(directory, 'run'),
      logPath,
      accounts: {
        root: { prefix: [], cwd: directory, environment },
        // an exec-style switch, as in production: it leaves no parent behind
        agent: {
          prefix: ['/usr/bin/env', 'SWITCHED=agent'],
          cwd: directory,
          environment,
        },
      },
      timerIntervalMs: TIMER_INTERVAL_MS,
      ...(timer.passDeadlineMs !== undefined && {
        passDeadlineMs: timer.passDeadlineMs,
      }),
      ...(timer.updateSettleMs !== undefined && {
        updateSettleMs: timer.updateSettleMs,
      }),
      update: {
        checkFile: join(directory, 'update-check-minutes'),
        command:
          timer.update?.(directory) ??
          `echo ran >> ${join(directory, 'updates')}`,
        trusted: [],
        environment,
      },
    },
  };
  const socket = join(directory, 'run', 'control.sock');

  return {
    directory,
    log: async () => readFile(logPath, 'utf8').catch(() => ''),
    start: async () => {
      const child = spawn(
        execPath,
        ['--input-type=module', '-e', DAEMON_RUNNER],
        {
          env: { ...process.env, OA_DAEMON: JSON.stringify(params) },
          stdio: ['ignore', 'pipe', 'inherit'],
        },
      );
      running.push(child);
      const [ready] = (await once(child.stdout, 'data')) as [Buffer];
      expect(ready.toString()).toContain('ready');
      const exited = once(child, 'exit') as Promise<[number | null]>;

      return {
        request: async (request) =>
          requestSupervisor(socket, request, REQUEST_WAIT_MS),
        stop: async () => {
          child.kill('SIGTERM');
          const [code] = await exited;

          return code;
        },
      };
    },
    [Symbol.asyncDispose]: async () => {
      for (const child of running) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
      await scratch[Symbol.asyncDispose]();
    },
  };
}

/**
 * defines a service that records each start's process id, then sleeps
 * @param directory where the service records its starts
 * @param name service identifier
 * @param overrides fields the test sets
 * @returns the definition
 */
function sleeper(
  directory: string,
  name: string,
  overrides: Partial<SupervisedService> = {},
): SupervisedService {
  return {
    name,
    command: '/bin/sh',
    arguments: [
      '-c',
      `echo $$ >> ${pidFile(directory, name)}; exec sleep 300`,
      name,
    ],
    account: 'agent',
    needs: [],
    ...overrides,
  };
}

/**
 * defines a service that runs as root and sleeps like a sleeper: a root
 * service is given whole paths only, so its script is a file, not an argument
 * @param directory where the service records its starts and keeps its script
 * @param name service identifier
 * @returns the definition
 */
async function rootSleeper(
  directory: string,
  name: string,
): Promise<SupervisedService> {
  const script = join(directory, `${name}.sh`);
  await writeFile(
    script,
    `echo $$ >> ${pidFile(directory, name)}\nexec sleep 300\n`,
  );

  return {
    name,
    command: '/bin/sh',
    arguments: [script],
    account: 'root',
    needs: [],
  };
}

/**
 * names the file a sleeper records its starts in
 * @param directory where the service records its starts
 * @param name service identifier
 * @returns absolute file path
 */
function pidFile(directory: string, name: string): string {
  return join(directory, `${name}.pids`);
}

/**
 * reads the process ids a sleeper recorded
 * @param directory where the service records its starts
 * @param name service identifier
 * @returns one id per start
 */
async function startsOf(directory: string, name: string): Promise<number[]> {
  const text = await readFile(pidFile(directory, name), 'utf8').catch(() => '');

  return text.split('\n').filter(Boolean).map(Number);
}

/**
 * counts the runs a crashing service recorded, one line each
 * @param file where the service records its runs
 * @returns the number of runs
 */
async function runsIn(file: string): Promise<number> {
  return (await readFile(file, 'utf8')).split('\n').length - 1;
}

/**
 * tells whether a process still exists
 * @param pid process id
 * @returns whether it exists
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

/**
 * waits until a check passes
 * @param check the condition
 * @param timeoutMs how long to wait
 */
async function until(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('The condition did not hold in time');
    }
    await delay(POLL_MS);
  }
}

/**
 * lists the services as name and status
 * @param daemon a started supervisor process
 * @returns each service's name and status
 */
async function statuses(
  daemon: RunningDaemon,
): Promise<Array<{ name: string; status?: string }>> {
  const response = await daemon.request({ action: 'list' });
  if (!response.ok) {
    throw new Error(response.error);
  }

  return (response.services ?? []).map(({ name, status }) => ({
    name,
    status,
  }));
}

describe('packed guest supervisor', () => {
  it('should stage every supervisor module root-only', async () => {
    const modules = await readdir(join(guestRoot, 'guest/supervisor'));
    const modes = await Promise.all(
      modules.map(
        async (module) =>
          (await stat(join(guestRoot, 'guest/supervisor', module))).mode &
          0o777,
      ),
    );

    expect({ modules: modules.toSorted(), modes: [...new Set(modes)] }).toEqual(
      {
        modules: [
          'client.js',
          'control.js',
          'daemon.js',
          'entries.js',
          'fault.js',
          'log.js',
          'main.js',
          'processes.js',
          'protocol.js',
          'runner.js',
          'server.js',
          'store.js',
          'supervisor.js',
          'timer.js',
        ],
        modes: [ROOT_ONLY_MODE],
      },
    );
  });

  it(
    'should leave an unchanged service running and replace a changed one',
    async () => {
      await using station = await workstation();
      const daemon = await station.start();
      const { directory } = station;
      const definition = sleeper(directory, 'alpha');

      const first = await daemon.request({ action: 'ensure', definition });
      const again = await daemon.request({ action: 'ensure', definition });
      const kept = await startsOf(directory, 'alpha');
      const changed = await daemon.request({
        action: 'ensure',
        definition: {
          ...definition,
          arguments: [...definition.arguments, 'v2'],
        },
      });
      const starts = await startsOf(directory, 'alpha');

      expect({
        answers: [first, again, changed],
        kept,
        starts: starts.length,
        isFirstAlive: isAlive(starts[0] ?? 0),
        isSecondAlive: isAlive(starts[1] ?? 0),
        services: await statuses(daemon),
        log: await station.log(),
      }).toEqual({
        answers: [{ ok: true }, { ok: true }, { ok: true }],
        kept: [expect.any(Number)],
        starts: 2,
        isFirstAlive: false,
        isSecondAlive: true,
        services: [
          { name: 'alpha', status: 'running' },
          { name: 'open-agent-timer', status: 'running' },
        ],
        log: expect.stringContaining('service=alpha event=replaced'),
      });
      expect(await daemon.stop()).toBe(0);
    },
    SLOW_TEST_MS,
  );

  it(
    'should start a service only after the services it needs and refuse what it cannot honour',
    async () => {
      await using station = await workstation();
      const daemon = await station.start();
      const { directory } = station;

      const unregistered = await daemon.request({
        action: 'ensure',
        definition: sleeper(directory, 'consumer', { needs: ['daemon'] }),
      });
      const daemonService = await daemon.request({
        action: 'ensure',
        definition: await rootSleeper(directory, 'daemon'),
      });
      const consumer = await daemon.request({
        action: 'ensure',
        definition: sleeper(directory, 'consumer', { needs: ['daemon'] }),
      });
      const removal = await daemon.request({
        action: 'remove',
        name: 'daemon',
      });
      const stopped = await daemon.request({ action: 'stop', name: 'daemon' });
      const late = await daemon.request({
        action: 'ensure',
        definition: sleeper(directory, 'late', { needs: ['daemon'] }),
      });
      const missing = await daemon.request({ action: 'stop', name: 'absent' });
      const timer = await daemon.request({
        action: 'stop',
        name: 'open-agent-timer',
      });
      const log = await station.log();

      expect({
        answers: { unregistered, daemonService, consumer, removal, stopped },
        refusals: [late, missing, timer].map((answer) =>
          answer.ok ? 'ok' : answer.code,
        ),
        order: [...log.matchAll(/service=(\w+) event=start/gu)].map(
          ([, name]) => name,
        ),
        services: await statuses(daemon),
      }).toEqual({
        answers: {
          unregistered: {
            ok: false,
            code: 'conflict',
            error: 'consumer needs daemon, which is not registered',
          },
          daemonService: { ok: true },
          consumer: { ok: true },
          removal: {
            ok: false,
            code: 'conflict',
            error: 'daemon is needed by consumer',
          },
          stopped: { ok: true, stopped: true },
        },
        refusals: ['conflict', 'not-found', 'invalid'],
        order: ['daemon', 'consumer'],
        services: [
          { name: 'daemon', status: 'stopped' },
          { name: 'consumer', status: 'running' },
          { name: 'open-agent-timer', status: 'running' },
        ],
      });
      expect(await daemon.stop()).toBe(0);
    },
    SLOW_TEST_MS,
  );

  it(
    'should restart a service that exits after a growing delay and log each exit',
    async () => {
      await using station = await workstation();
      const daemon = await station.start();
      const runs = join(station.directory, 'runs');

      const ensured = await daemon.request({
        action: 'ensure',
        definition: {
          name: 'crasher',
          command: '/bin/sh',
          arguments: ['-c', `echo run >> ${runs}; exit 3`],
          account: 'agent',
          needs: [],
        },
      });
      // the answer comes with the first run's exit, not a later run
      const runsAtAnswer = await runsIn(runs);
      const exitsLogged = async (): Promise<number[]> =>
        [
          ...(await station.log()).matchAll(
            /service=crasher event=exit pid=\d+ code=3 uptime_ms=\d+ restart_in_ms=(\d+)/gu,
          ),
        ].map(([, wait]) => Number(wait));
      await until(async () => (await exitsLogged()).length >= 3);
      const exits = await exitsLogged();
      const runCount = await runsIn(runs);
      const removed = await daemon.request({
        action: 'remove',
        name: 'crasher',
      });

      expect({
        ensured,
        runsAtAnswer,
        exits: exits.slice(0, 3),
        isRunEachTime: runCount >= 3,
        removed,
        services: await statuses(daemon),
      }).toEqual({
        ensured: {
          ok: false,
          code: 'failed',
          error: 'crasher exited during startup (exit code 3)',
        },
        runsAtAnswer: 1,
        exits: [1_000, 2_000, 4_000],
        isRunEachTime: true,
        removed: { ok: true },
        services: [{ name: 'open-agent-timer', status: 'running' }],
      });
      expect(await daemon.stop()).toBe(0);
    },
    SLOW_TEST_MS,
  );

  it(
    'should start a service whose earlier startup crash is fixed',
    async () => {
      await using station = await workstation();
      const daemon = await station.start();
      const { directory } = station;
      const ready = join(directory, 'ready');
      const definition = sleeper(directory, 'recovered', {
        arguments: [
          '-c',
          `test -e ${ready} || exit 3; echo $$ >> ${pidFile(directory, 'recovered')}; exec sleep 300`,
          'recovered',
        ],
      });

      const crashed = await daemon.request({ action: 'ensure', definition });
      await writeFile(ready, '');
      const fixed = await daemon.request({ action: 'ensure', definition });

      expect({
        answers: [crashed, fixed],
        starts: (await startsOf(directory, 'recovered')).length,
      }).toEqual({
        answers: [
          {
            ok: false,
            code: 'failed',
            error: 'recovered exited during startup (exit code 3)',
          },
          { ok: true },
        ],
        starts: 1,
      });
      expect(await daemon.stop()).toBe(0);
    },
    SLOW_TEST_MS,
  );

  it(
    'should report a dependent that crashes while an earlier one restarts after a replacement',
    async () => {
      await using station = await workstation();
      const daemon = await station.start();
      const { directory } = station;
      const broken = join(directory, 'broken');
      const runs = join(directory, 'runs');
      const base = sleeper(directory, 'base');
      await daemon.request({ action: 'ensure', definition: base });
      await daemon.request({
        action: 'ensure',
        definition: sleeper(directory, 'first', { needs: ['base'] }),
      });
      await daemon.request({
        action: 'ensure',
        definition: sleeper(directory, 'second', {
          arguments: [
            '-c',
            `test -e ${broken} && { echo run >> ${runs}; exit 3; }; exec sleep 300`,
            'second',
          ],
          needs: ['base'],
        }),
      });
      await writeFile(broken, '');

      const replaced = await daemon.request({
        action: 'ensure',
        definition: { ...base, arguments: [...base.arguments, 'v2'] },
      });
      // the answer comes with the run that crashed while first started, not a later run
      const runsAtAnswer = await runsIn(runs);

      expect({ replaced, runsAtAnswer }).toEqual({
        replaced: {
          ok: false,
          code: 'failed',
          error: 'second exited during startup (exit code 3)',
        },
        runsAtAnswer: 2,
      });
      expect(await daemon.stop()).toBe(0);
    },
    SLOW_TEST_MS,
  );

  it(
    'should end every service on stop and restore the recorded ones on the next start',
    async () => {
      await using station = await workstation();
      const { directory } = station;
      const first = await station.start();
      await first.request({
        action: 'ensure',
        definition: sleeper(directory, 'kept'),
      });
      await first.request({
        action: 'ensure',
        definition: sleeper(directory, 'paused'),
      });
      await first.request({ action: 'stop', name: 'paused' });
      const [before = 0] = await startsOf(directory, 'kept');

      const exitCode = await first.stop();
      const isEnded = !isAlive(before);
      const second = await station.start();
      await until(async () => (await startsOf(directory, 'kept')).length === 2);
      const state = await stat(join(directory, 'state/services.json'));

      expect({
        exitCode,
        isEnded,
        services: await statuses(second),
        pausedStarts: (await startsOf(directory, 'paused')).length,
        stateMode: state.mode & 0o777,
      }).toEqual({
        exitCode: 0,
        isEnded: true,
        services: [
          { name: 'kept', status: 'running' },
          { name: 'paused', status: 'stopped' },
          { name: 'open-agent-timer', status: 'running' },
        ],
        pausedStarts: 1,
        stateMode: PRIVATE_FILE_MODE,
      });
      expect(await second.stop()).toBe(0);
    },
    SLOW_TEST_MS,
  );

  it(
    'should run the update entry only once its check file exists and log the governor decision',
    async () => {
      await using station = await workstation();
      const { directory } = station;
      const updates = join(directory, 'updates');
      const daemon = await station.start();

      await until(
        async () =>
          (
            await readFile(join(directory, 'ticks'), 'utf8').catch(() => '')
          ).split('\n').length > 3,
      );
      const isUpdatedEarly = await stat(updates).then(
        () => true,
        () => false,
      );
      await writeFile(join(directory, 'update-check-minutes'), '30\n');
      await until(async () =>
        stat(updates).then(
          () => true,
          () => false,
        ),
      );
      const log = await station.log();

      expect({
        isUpdatedEarly,
        decisions: log.match(
          /governor=enter-idle-form result=memory-suspend/gu,
        ),
        notes: log.match(/governor=notes notes="fixture note"/gu),
        services: await statuses(daemon),
      }).toEqual({
        isUpdatedEarly: false,
        decisions: ['governor=enter-idle-form result=memory-suspend'],
        notes: ['governor=notes notes="fixture note"'],
        services: [{ name: 'open-agent-timer', status: 'running' }],
      });
      expect(await daemon.stop()).toBe(0);
    },
    SLOW_TEST_MS,
  );

  it(
    'should give a service its whole stop grace behind an exec-style account switch',
    async () => {
      await using station = await workstation();
      const { directory } = station;
      const finished = join(directory, 'slow.finished');
      const daemon = await station.start();
      await daemon.request({
        action: 'ensure',
        definition: sleeper(directory, 'slow', {
          arguments: [
            '-c',
            `trap 'sleep 3; echo done > ${finished}; exit 0' TERM; echo $$ >> ${pidFile(directory, 'slow')}; while :; do sleep 0.2; done`,
            'slow',
          ],
        }),
      });
      const [pid = 0] = await startsOf(directory, 'slow');

      const stoppedAt = Date.now();
      const stopped = await daemon.request({ action: 'stop', name: 'slow' });
      const waitedMs = Date.now() - stoppedAt;

      expect({
        stopped,
        // runuser's watching parent killed its service 2 s after SIGTERM
        isGraceWhole: waitedMs >= 2_500,
        finished: await readFile(finished, 'utf8').catch(() => 'never'),
        isGone: !isAlive(pid),
        log: await station.log(),
      }).toEqual({
        stopped: { ok: true, stopped: true },
        isGraceWhole: true,
        finished: 'done\n',
        isGone: true,
        log: expect.not.stringContaining('event=kill'),
      });
      expect(await daemon.stop()).toBe(0);
    },
    SLOW_TEST_MS,
  );

  it(
    'should not tick the governor while the update entry it started still runs',
    async () => {
      await using station = await workstation({
        updateSettleMs: 100,
        // the first run is an update that outlasts the settle window; later runs end at once
        update: (directory) =>
          `[ -e ${join(directory, 'updated')} ] || { touch ${join(directory, 'updating')}; sleep 1.5; touch ${join(directory, 'updated')}; rm ${join(directory, 'updating')}; }`,
      });
      const { directory } = station;
      await writeFile(join(directory, 'update-check-minutes'), '30\n');
      const daemon = await station.start();

      await until(async () =>
        stat(join(directory, 'updated')).then(
          () => true,
          () => false,
        ),
      );
      await until(
        async () =>
          (await readFile(join(directory, 'ticks'), 'utf8').catch(() => ''))
            .split('\n')
            .filter((line) => line === 'tick').length >= 2,
      );
      const ticks = (await readFile(join(directory, 'ticks'), 'utf8'))
        .split('\n')
        .filter(Boolean);

      expect({
        duringUpdate: ticks.filter((line) => line === 'tick-during-update'),
        isTickingAgain: ticks.includes('tick'),
      }).toEqual({ duringUpdate: [], isTickingAgain: true });
      expect(await daemon.stop()).toBe(0);
    },
    SLOW_TEST_MS,
  );

  it(
    'should abandon a pass that never settles, log it, and keep arming the timer',
    async () => {
      await using station = await workstation({
        hangFirstTick: true,
        passDeadlineMs: 300,
      });
      const { directory } = station;
      const daemon = await station.start();

      await until(
        async () =>
          (await readFile(join(directory, 'ticks'), 'utf8').catch(() => ''))
            .split('\n')
            .filter(Boolean).length >= 3,
      );
      const log = await station.log();

      expect({
        abandoned: log.match(/timer=pass failure="abandoned after 300 ms"/gu),
        services: await statuses(daemon),
      }).toEqual({
        abandoned: ['timer=pass failure="abandoned after 300 ms"'],
        // the abandoned pass never ended, which the listing keeps reporting
        services: [{ name: 'open-agent-timer', status: 'failed' }],
      });
      expect(await daemon.stop()).toBe(0);
    },
    SLOW_TEST_MS,
  );

  it(
    'should never run a supervisor main that another account controls',
    async () => {
      await using scratch = await mkdtempDisposable(
        join(tmpdir(), 'oa-entry-'),
      );
      const directory = await realpath(scratch.path);
      const entry = pathToFileURL(
        join(packed, 'lib/guest/supervisor/entry.js'),
      ).href;
      const marker = join(directory, 'ran');
      const main = join(directory, 'main.js');
      const log = join(directory, 'supervisor.log');
      await writeFile(
        main,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`,
      );
      const { stdout: script } = await execa(
        execPath,
        [
          '--input-type=module',
          '-e',
          `const { supervisorEntryScript } = await import(${JSON.stringify(entry)});
process.stdout.write(supervisorEntryScript(${JSON.stringify({ node: execPath, main, log })}));`,
        ],
        { stripFinalNewline: false },
      );
      const path = join(directory, 'open-agent-supervisor');
      await writeFile(path, script, { mode: ROOT_ONLY_MODE });
      const syntax = await execa('/bin/sh', ['-n', path], { reject: false });

      const run = execa(path, [], { reject: false });
      await until(async () =>
        (await readFile(log, 'utf8').catch(() => '')).includes(
          'supervisor=refused',
        ),
      );
      run.kill('SIGTERM');
      const { exitCode } = await run;

      expect({
        syntax: syntax.exitCode,
        shebang: script.split('\n', 1)[0],
        exitCode,
        hasRun: await stat(marker).then(
          () => true,
          () => false,
        ),
        isTransferring: /\bchown\b/u.test(script),
      }).toEqual({
        syntax: 0,
        shebang: '#!/bin/sh',
        exitCode: 0,
        hasRun: false,
        isTransferring: false,
      });
    },
    SLOW_TEST_MS,
  );
});
