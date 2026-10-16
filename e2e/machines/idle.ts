import { WebSocket } from 'ws';

import { T3_HTTP_PORT } from '#drivers/agents/t3/service';

import { asRoot } from './guest';
import { GOVERNOR_REPORT, reportedGovernorState } from './layout';

import type { MachineProvider, RunState } from './providers';

/** what the governor records, as the proof reads it */
export interface GovernorState {
  /** idle minutes the governor applies */
  idleTimeoutMinutes: number;
  /** minutes a hold lasts after its last refresh */
  holdMaxMinutes: number;
  /** when the governor last saw a heartbeat */
  lastHeartbeat: string | undefined;
  /** holds still open, latest expiry first */
  holds: GovernorHold[];
  /** how many holds are open */
  openHolds: number;
  /** the deadline the workstation stays awake until, absent when nothing keeps it awake */
  deadline: string | undefined;
}

/** one open hold the governor records */
export interface GovernorHold {
  /** harness or managed operation that opened it */
  source: string;
  /** when it expires unless refreshed */
  expiresAt: string;
}

/** one real harness turn whose tool call sleeps */
export interface HarnessTurn {
  /** short tag that names the turn's guest files */
  tag: string;
  /** how long the turn's tool call sleeps */
  sleepSeconds: number;
}

/** how a harness turn ended */
export interface TurnOutcome {
  /** the harness command's exit status */
  exitCode: number;
  /** when the turn started */
  startedAt: string;
  /** when the harness command ended */
  endedAt: string;
  /** the harness's final reply, when it printed one */
  reply: string | undefined;
}

/** a time the guest stopped running, seen as a gap in its own once-a-second ticks */
export interface GuestPause {
  /** the last tick before the gap */
  from: string;
  /** the first tick after the gap */
  to: string;
  /** the gap's length in seconds */
  seconds: number;
}

/** one second's record of the Sprite's awake task and the governor's record */
export interface AwakeSample {
  /** when the guest recorded it */
  at: string;
  /** when the awake task expires, absent when the Sprite had no such task */
  taskExpiresAt: string | undefined;
  /** the governor's deadline */
  deadline: string | undefined;
  /** the governor's open holds */
  openHolds: number | undefined;
  /** the governor's last heartbeat */
  lastHeartbeat: string | undefined;
}

/** one read of the provider's run state */
export interface RunSample extends RunState {
  /** when the proof read it */
  at: string;
}

/** an open, authenticated connection to the ACP agent */
export interface AgentConnection {
  /** whether the connection is still open */
  isOpen(): boolean;
  /** closes the connection and waits until it has closed */
  close(): Promise<void>;
}

const TURN_DIRECTORY = '/tmp';
const TURN_POLL_MS = 3_000;
const TURN_START_TIMEOUT_MS = 3 * 60_000;
// generous for model latency on both sides of the tool call
const TURN_LATENCY_MS = 5 * 60_000;
const TICK_LOG = '/run/open-agent-e2e-ticks';
const AWAKE_LOG = '/run/open-agent-e2e-awake';
const AWAKE_TASK = 'open-agent-awake';
const SPRITE_SOCKET = '/.sprite/api.sock';
// a tick is written every second, so a longer gap means the guest did not run
const PAUSE_SECONDS = 3;
const RUN_STATE_POLL_MS = 3_000;
// a minute of failed reads in one watch is an outage, not a blip
const RUN_STATE_FAILURES = 20;
const CONNECTION_TIMEOUT_MS = 30_000;
const SECOND_MS = 1000;
// a harness tool call may run longer than its default 2 minute limit
const TOOL_TIMEOUT_MS = 600_000;

/**
 * reads the governor state straight from the guest
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the recorded state
 */
export async function readGovernor(
  provider: MachineProvider,
  name: string,
): Promise<GovernorState> {
  const state = reportedGovernorState(
    await asRoot(provider, name, GOVERNOR_REPORT),
  ) as Partial<GovernorState> & {
    holds?: Array<GovernorHold & { session?: string }>;
  };

  return {
    idleTimeoutMinutes: state.idleTimeoutMinutes ?? Number.NaN,
    holdMaxMinutes: state.holdMaxMinutes ?? Number.NaN,
    lastHeartbeat: state.lastHeartbeat,
    holds: (state.holds ?? []).map(({ source, expiresAt }) => ({
      source,
      expiresAt,
    })),
    openHolds: state.openHolds ?? Number.NaN,
    deadline: state.deadline,
  };
}

/**
 * starts a real Claude Code turn as the agent account, through the route the
 * profile configured, whose single tool call sleeps; the turn runs detached,
 * so nothing but the turn itself keeps the workstation awake
 * @param provider selected provider
 * @param name exact workstation name
 * @param turn the turn to start
 */
export async function startHarnessTurn(
  provider: MachineProvider,
  name: string,
  turn: HarnessTurn,
): Promise<void> {
  const files = turnFiles(turn.tag);
  const prompt = `Use the Bash tool to run exactly this command: sleep ${turn.sleepSeconds}. Then reply with the single word done.`;
  const script = [
    'cd "$HOME"',
    `date -u +%Y-%m-%dT%H:%M:%S.%3NZ > ${files.start}`,
    `BASH_DEFAULT_TIMEOUT_MS=${TOOL_TIMEOUT_MS} BASH_MAX_TIMEOUT_MS=${TOOL_TIMEOUT_MS} claude -p '${prompt}' --allowedTools 'Bash(sleep:*)' --output-format json < /dev/null > ${files.output} 2> ${files.errors}`,
    `echo $? > ${files.exit}.new`,
    `date -u +%Y-%m-%dT%H:%M:%S.%3NZ > ${files.end}`,
    `mv ${files.exit}.new ${files.exit}`,
    '',
  ].join('\n');
  await asRoot(
    provider,
    name,
    [
      'set -e',
      `rm -f ${files.start} ${files.end} ${files.exit} ${files.output} ${files.errors}`,
      `echo ${Buffer.from(script).toString('base64')} | base64 -d > ${files.script}`,
      `chmod 644 ${files.script}`,
      `runuser -l agent -c 'setsid nohup sh ${files.script} >/dev/null 2>&1 </dev/null &'`,
    ].join('\n'),
  );
}

/**
 * waits until the turn's tool call runs
 * @param provider selected provider
 * @param name exact workstation name
 * @param turn the running turn
 */
export async function waitForToolCall(
  provider: MachineProvider,
  name: string,
  turn: HarnessTurn,
): Promise<void> {
  const deadline = Date.now() + TURN_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const running = await asRoot(
      provider,
      name,
      `pgrep -u agent -x sleep -a | grep -cx '[0-9]* sleep ${turn.sleepSeconds}' || true`,
    );
    if (Number(running.trim()) > 0) {
      return;
    }
    await sleep(TURN_POLL_MS);
  }
  throw new Error(`The ${turn.tag} turn's tool call did not start in time`);
}

/**
 * ends the turn's tool call the way a crash would: the harness is killed
 * mid-turn, so its turn-end hook never runs
 * @param provider selected provider
 * @param name exact workstation name
 * @param turn the running turn
 */
export async function crashHarnessTurn(
  provider: MachineProvider,
  name: string,
  turn: HarnessTurn,
): Promise<void> {
  await asRoot(
    provider,
    name,
    // the harness's own command line carries the prompt, which names the command
    `pkill -KILL -u agent -f 'exactly this command: sleep ${turn.sleepSeconds}\\.'; pkill -KILL -u agent -fx 'sleep ${turn.sleepSeconds}'; true`,
  );
}

/**
 * waits until the turn's harness command has ended
 * @param provider selected provider
 * @param name exact workstation name
 * @param turn the running turn
 * @returns how it ended
 */
export async function waitForTurnEnd(
  provider: MachineProvider,
  name: string,
  turn: HarnessTurn,
): Promise<TurnOutcome> {
  const files = turnFiles(turn.tag);
  const deadline = Date.now() + turn.sleepSeconds * SECOND_MS + TURN_LATENCY_MS;
  while (Date.now() < deadline) {
    const exit = (
      await asRoot(provider, name, `cat ${files.exit} 2>/dev/null || true`)
    ).trim();
    if (exit !== '') {
      const [startedAt = '', endedAt = ''] = (
        await asRoot(provider, name, `cat ${files.start} ${files.end}`)
      )
        .trim()
        .split('\n');
      const output = await asRoot(
        provider,
        name,
        `cat ${files.output} 2>/dev/null || true`,
      );

      return {
        exitCode: Number(exit),
        startedAt,
        endedAt,
        reply: readReply(output),
      };
    }
    await sleep(TURN_POLL_MS);
  }
  throw new Error(`The ${turn.tag} turn did not end in time`);
}

/**
 * starts a root loop that records, once a second, the Sprite's awake task and
 * the governor's record, so a later read shows whether the task existed at
 * every moment the governor wanted the Sprite awake
 * @param provider selected provider
 * @param name exact workstation name
 */
export async function startAwakeLog(
  provider: MachineProvider,
  name: string,
): Promise<void> {
  const tasks = `runuser -u agent -- curl -s --max-time 2 --unix-socket ${SPRITE_SOCKET} http://sprite/v1/tasks | tr -d "\\n"`;
  const governor = `${GOVERNOR_REPORT} | tr -d "\\n"`;

  await asRoot(
    provider,
    name,
    `setsid nohup /bin/sh -c 'while :; do printf "%s\\t%s\\t%s\\n" "$(date +%s.%N)" "$(${tasks})" "$(${governor})" >> ${AWAKE_LOG}; sleep 1; done' >/dev/null 2>&1 </dev/null & echo $! > ${AWAKE_LOG}.pid`,
  );
}

/**
 * stops the awake sampler, so it cannot keep the Sprite busy, and reads the
 * samples it recorded within a window
 * @param provider selected provider
 * @param name exact workstation name
 * @param window earliest and latest sample to keep
 * @param window.from earliest sample
 * @param window.to latest sample
 * @returns each sample, in order
 */
export async function stopAwakeLog(
  provider: MachineProvider,
  name: string,
  window: { from: string; to: string },
): Promise<AwakeSample[]> {
  const [from, to] = [Date.parse(window.from), Date.parse(window.to)];
  const lines = (
    await asRoot(
      provider,
      name,
      `kill "$(cat ${AWAKE_LOG}.pid)" 2>/dev/null; cat ${AWAKE_LOG}`,
    )
  )
    .split('\n')
    .filter(Boolean);

  return lines.flatMap((line) => {
    const [seconds, tasks, governor] = line.split('\t');
    const at = Number(seconds) * SECOND_MS;
    if (!(at >= from && at <= to)) {
      return [];
    }
    const task = parseJson<{
      tasks?: Array<{ name: string; expires_at: string }>;
    }>(tasks)?.tasks?.find((entry) => entry.name === AWAKE_TASK);
    const state = parseJson<{ state?: Partial<GovernorState> }>(
      governor,
    )?.state;

    return [
      {
        at: new Date(at).toISOString(),
        taskExpiresAt: task?.expires_at,
        deadline: state?.deadline,
        openHolds: state?.openHolds,
        lastHeartbeat: state?.lastHeartbeat,
      },
    ];
  });
}

/**
 * parses a recorded JSON value, which a sample cut short leaves invalid
 * @param text recorded text
 * @returns the value, or nothing when the text is not JSON
 */
function parseJson<T>(text: string | undefined): T | undefined {
  try {
    return JSON.parse(text ?? '') as T;
  } catch {
    return undefined;
  }
}

/**
 * starts a root loop that records the guest clock once a second, so a later
 * read shows every time the guest did not run
 * @param provider selected provider
 * @param name exact workstation name
 */
export async function startTickLog(
  provider: MachineProvider,
  name: string,
): Promise<void> {
  await asRoot(
    provider,
    name,
    `setsid nohup /bin/sh -c 'while :; do date +%s.%N >> ${TICK_LOG}; sleep 1; done' >/dev/null 2>&1 </dev/null &`,
  );
}

/**
 * reads every pause in the guest's ticks after a time
 * @param provider selected provider
 * @param name exact workstation name
 * @param since earliest tick to consider
 * @returns the pauses, in order
 */
export async function readPauses(
  provider: MachineProvider,
  name: string,
  since: string,
): Promise<GuestPause[]> {
  // the read itself is the last tick, so a pause it ends is seen whole
  const ticks = (await asRoot(provider, name, `cat ${TICK_LOG}; date +%s.%N`))
    .split('\n')
    .filter(Boolean)
    .map((tick) => Number(tick) * SECOND_MS)
    .filter((tick) => tick >= Date.parse(since));

  return ticks.slice(1).flatMap((tick, index) => {
    const previous = ticks[index]!;
    const seconds = (tick - previous) / SECOND_MS;

    return seconds > PAUSE_SECONDS
      ? [
          {
            from: new Date(previous).toISOString(),
            to: new Date(tick).toISOString(),
            seconds: Math.round(seconds),
          },
        ]
      : [];
  });
}

/**
 * reads the provider's run state over a window without touching the guest,
 * skipping records that carry no transition times and reads that fail
 * @param provider selected provider
 * @param name exact workstation name
 * @param window how long to watch and when to stop early
 * @param window.durationMs the longest the watch lasts
 * @param window.until stops once a sample satisfies it
 * @param window.settleMs how long to keep watching once `until` is satisfied
 * @returns every sample read
 */
export async function watchRunStates(
  provider: MachineProvider,
  name: string,
  window: {
    durationMs: number;
    until?: (sample: RunSample) => boolean;
    settleMs?: number;
  },
): Promise<RunSample[]> {
  const { durationMs, until, settleMs = 0 } = window;
  const samples: RunSample[] = [];
  const failures: unknown[] = [];
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const at = new Date().toISOString();
    // the management API fails transiently; a read it fails is a gap, not a state
    const state = await provider.readRunState(name).catch((error: unknown) => {
      failures.push(error);
      if (failures.length > RUN_STATE_FAILURES) {
        throw new Error(
          `The provider failed ${failures.length} run-state reads`,
          {
            cause: error,
          },
        );
      }

      return undefined;
    });
    if (state) {
      const sample = { ...state, at };
      samples.push(sample);
      if (until?.(sample)) {
        // keep the guest untouched a while longer, so its own clock shows the pause
        return [
          ...samples,
          ...(settleMs > 0
            ? await watchRunStates(provider, name, { durationMs: settleMs })
            : []),
        ];
      }
    }
    await sleep(RUN_STATE_POLL_MS);
  }

  return samples;
}

/**
 * tells whether a sample shows the workstation asleep
 * @param sample one run-state read
 * @returns true once the provider reports a sleeping state
 */
export function isAsleep(sample: RunState): boolean {
  return sample.status !== 'running' && sample.lastWarmingAt !== undefined;
}

/**
 * opens an authenticated connection to the ACP agent at the provider URL with
 * a short-lived session the agent itself issues; the credential stays in memory
 * @param provider selected provider
 * @param name exact workstation name
 * @param url where the provider routes requests to the workstation
 * @returns a connection that stays open until it is closed
 */
export async function openAgentConnection(
  provider: MachineProvider,
  name: string,
  url: string,
): Promise<AgentConnection> {
  const issued = JSON.parse(
    await asRoot(
      provider,
      name,
      `runuser -l agent -c 't3 auth session issue --base-dir ~/.t3 --ttl 15m --label open-agent-e2e --json'`,
    ),
  ) as { token: string };
  // T3 refuses, with 426, a connection that names no orchestration protocol
  // or another than the one its environment endpoint reports
  const { orchestrationProtocolVersion } = JSON.parse(
    await asRoot(
      provider,
      name,
      `/usr/bin/curl --silent --fail --max-time 5 http://127.0.0.1:${String(T3_HTTP_PORT)}/.well-known/t3/environment`,
    ),
  ) as { orchestrationProtocolVersion?: number };
  const query =
    orchestrationProtocolVersion === undefined
      ? ''
      : `?orchestrationProtocol=${String(orchestrationProtocolVersion)}`;
  const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/ws${query}`, {
    headers: { Authorization: `Bearer ${issued.token}` },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('The agent connection did not open in time'));
    }, CONNECTION_TIMEOUT_MS);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`The agent connection failed: ${error.message}`));
    });
  });

  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    close: async () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();

          return;
        }
        socket.once('close', () => {
          resolve();
        });
        socket.close();
      }),
  };
}

/**
 * names the guest files of one turn
 * @param tag short label that keeps one turn's files apart from another's
 * @returns the turn's file paths
 */
function turnFiles(
  tag: string,
): Record<'script' | 'start' | 'end' | 'exit' | 'output' | 'errors', string> {
  const base = `${TURN_DIRECTORY}/open-agent-e2e-turn-${tag}`;

  return {
    script: `${base}.sh`,
    start: `${base}.start`,
    end: `${base}.end`,
    exit: `${base}.exit`,
    output: `${base}.json`,
    errors: `${base}.err`,
  };
}

/**
 * reads the final reply from the harness's JSON output
 * @param output what the harness printed
 * @returns the reply, when the output carries one
 */
function readReply(output: string): string | undefined {
  try {
    const { result } = JSON.parse(output) as { result?: unknown };

    return typeof result === 'string' ? result : undefined;
  } catch {
    return undefined;
  }
}

/**
 * waits without blocking the event loop
 * @param ms milliseconds to wait
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
