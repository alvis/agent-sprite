import { asRoot } from './guest';
import { GOVERNOR_REPORT, reportedGovernorState } from './layout';
import { sleep, SECOND_MS } from './timing';

import type { MachineProvider, RunState } from './providers';

export {
  isAsleep,
  openAgentConnection,
  readPauses,
  startAwakeLog,
  startTickLog,
  stopAwakeLog,
  watchRunStates,
} from './idle/observation';

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
const TURN_START_TIMEOUT_MS = 180_000;
// generous for model latency on both sides of the tool call
const TURN_LATENCY_MS = 300_000;
// a tick is written every second, so a longer gap means the guest did not run
// a minute of failed reads in one watch is an outage, not a blip
// a harness tool call may run longer than its default 2 minute limit
const TOOL_TIMEOUT_MS = 600_000;
// Claude Code refuses a standalone `sleep` as a Bash command and has the
// model run it in the background instead, which ends the turn while the
// command runs; the turn's tool call is therefore a script that sleeps, and
// background tasks are off, so the call can only run in the foreground
const TURN_ENVIRONMENT = [
  `BASH_DEFAULT_TIMEOUT_MS=${TOOL_TIMEOUT_MS}`,
  `BASH_MAX_TIMEOUT_MS=${TOOL_TIMEOUT_MS}`,
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1',
].join(' ');

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
  const prompt = `Use the Bash tool to run exactly this command: ${toolCommand(turn)}. Then reply with the single word done.`;
  const script = [
    'cd "$HOME"',
    `date -u +%Y-%m-%dT%H:%M:%S.%3NZ > ${files.start}`,
    `${TURN_ENVIRONMENT} claude -p '${prompt}' --allowedTools 'Bash(${toolCommand(turn)})' --output-format json < /dev/null > ${files.output} 2> ${files.errors}`,
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
      `rm -f ${files.tool} ${files.start} ${files.end} ${files.exit} ${files.output} ${files.errors}`,
      `echo ${Buffer.from(script).toString('base64')} | base64 -d > ${files.script}`,
      `echo 'sleep ${turn.sleepSeconds}' > ${files.tool}`,
      `chmod 644 ${files.script} ${files.tool}`,
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
    `pkill -KILL -u agent -f 'exactly this command: ${toolCommand(turn).replaceAll('.', '\\.')}\\.'; pkill -KILL -u agent -fx '${toolCommand(turn)}'; pkill -KILL -u agent -fx 'sleep ${turn.sleepSeconds}'; true`,
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
 * names the guest files of one turn
 * @param tag short label that keeps one turn's files apart from another's
 * @returns the turn's file paths
 */
function turnFiles(
  tag: string,
): Record<
  'script' | 'tool' | 'start' | 'end' | 'exit' | 'output' | 'errors',
  string
> {
  const base = `${TURN_DIRECTORY}/open-agent-e2e-turn-${tag}`;

  return {
    script: `${base}.sh`,
    tool: `${base}-tool.sh`,
    start: `${base}.start`,
    end: `${base}.end`,
    exit: `${base}.exit`,
    output: `${base}.json`,
    errors: `${base}.err`,
  };
}

/**
 * names the turn's single tool call: a script whose only command sleeps
 * @param turn the turn whose tool call it is
 * @returns the command the harness is asked to run
 */
function toolCommand(turn: HarnessTurn): string {
  return `sh ${turnFiles(turn.tag).tool}`;
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
