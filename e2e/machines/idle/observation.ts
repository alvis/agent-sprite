import { WebSocket } from 'ws';

import { T3_HTTP_PORT } from '#adapters/drivers/agents/t3/service';

import { asRoot } from '../guest';

import { GOVERNOR_REPORT } from '../layout';

import { sleep, SECOND_MS } from '../timing';

import type {
  AgentConnection,
  AwakeSample,
  GovernorState,
  GuestPause,
  RunSample,
} from '../idle';
import type { MachineProvider, RunState } from '../providers';

const TICK_LOG = '/run/open-agent-e2e-ticks';
const AWAKE_LOG = '/run/open-agent-e2e-awake';
const AWAKE_TASK = 'open-agent-awake';
const SPRITE_SOCKET = '/.sprite/api.sock';
const PAUSE_SECONDS = 3;
const RUN_STATE_POLL_MS = 3_000;
const RUN_STATE_FAILURES = 20;
const CONNECTION_TIMEOUT_MS = 30_000;

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
      tasks?: Array<{ name: string } & Record<'expires_at', string>>;
    }>(tasks)?.tasks?.find((entry) => entry.name === AWAKE_TASK);
    const { expires_at: taskExpiresAt } = task ?? {};
    const state = parseJson<{ state?: Partial<GovernorState> }>(
      governor,
    )?.state;

    return [
      {
        at: new Date(at).toISOString(),
        taskExpiresAt,
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
