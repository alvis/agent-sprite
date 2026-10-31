import { isTransportFault } from '#adapters/guest/platform/session/faults';
import { checkOperation } from '#kernel/operation';

import type { GuestExecResult } from '#application/ports/guest-channel';
import type {
  PlanReport,
  PlanRunParams,
  SetupStep,
  StepCommand,
  StepOutcome,
} from '#application/ports/plan';
import type { GuestSession, SessionCommand } from '#application/ports/session';

/** attempts a step retried on transport faults gets, counting the first */
const DEFAULT_ATTEMPTS = 3;
/** the most of a failed command's standard error a step's reason quotes */
const REASON_LENGTH = 500;

/** the outcome of one step run without a transport fault */
type StepResult = Pick<StepOutcome, 'status' | 'reason'>;

/**
 * runs a setup plan in one session: steps run in the order their needs allow,
 * each by its check, apply and verify, a need on a step an earlier plan
 * settled being met. A transport fault reopens the session and reruns the
 * step from its check; a failed optional step is recorded and its dependants
 * skipped; a failed critical step stops the plan
 * @param params the steps, the settled steps, the session opener and the progress callback
 * @returns every step's outcome
 */
export async function runPlan(params: PlanRunParams): Promise<PlanReport> {
  const { onProgress } = params;
  const slot = new SessionSlot(params.openSession);
  const outcomes: StepOutcome[] = [];
  const settled = params.settled ?? [];
  const succeeded = new Set<string>(settled);
  let isComplete = true;
  try {
    for (const step of orderSteps(params.steps, settled)) {
      checkOperation();
      const missing = step.needs.find((need) => !succeeded.has(need));
      const outcome: StepOutcome =
        isComplete && missing === undefined
          ? await attemptStep(step, slot, params)
          : {
              step,
              status: 'skipped' as const,
              attempts: 0,
              reason: isComplete
                ? `needs ${missing}, which did not succeed`
                : 'a critical step failed first',
            };
      outcomes.push(outcome);
      if (outcome.status === 'satisfied' || outcome.status === 'applied') {
        succeeded.add(step.id);
      }
      isComplete &&= outcome.status !== 'failed' || !step.critical;
      onProgress?.({ kind: 'step-finished', outcome });
    }
  } finally {
    await slot.close();
  }

  return { isComplete, steps: outcomes };
}

/**
 * runs one step, reopening the session and rerunning the step from its check
 * after each transport fault until its attempts run out
 * @param step the step to run
 * @param slot the plan's session, opened on first use
 * @param params the attempt limit and the progress callback
 * @returns the step's outcome
 */
async function attemptStep(
  step: SetupStep,
  slot: SessionSlot,
  params: Pick<PlanRunParams, 'attempts' | 'onProgress'>,
): Promise<StepOutcome> {
  const { attempts = DEFAULT_ATTEMPTS, onProgress } = params;
  for (let attempt = 1; ; attempt++) {
    onProgress?.({ kind: 'step-started', step, attempt });
    try {
      return { step, attempts: attempt, ...(await runStep(slot, step)) };
    } catch (error) {
      if (!isTransportFault(error)) {
        throw error;
      }
      await slot.lose();
      const reason = error.message;
      if (step.retry === 'never' || attempt >= attempts) {
        return { step, status: 'failed', attempts: attempt, reason };
      }
      onProgress?.({ kind: 'step-retrying', step, attempt, reason });
    }
  }
}

/** the plan's one open session, reopened after a transport fault */
class SessionSlot {
  readonly #open: PlanRunParams['openSession'];
  #session: GuestSession | undefined;
  #lost: number | undefined;

  /**
   * holds no session until a step needs one
   * @param open opens a session, naming the lost one it supersedes
   */
  constructor(open: PlanRunParams['openSession']) {
    this.#open = open;
  }

  /**
   * gives the session the next step runs in
   * @returns the open session, opened when there is none
   */
  public async session(): Promise<GuestSession> {
    this.#session ??= await this.#open(this.#lost);

    return this.#session;
  }

  /** drops a session a transport fault broke, remembering its pid */
  public async lose(): Promise<void> {
    this.#lost = this.#session?.pid ?? this.#lost;
    await this.close();
  }

  /** closes the open session */
  public async close(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    await session?.[Symbol.asyncDispose]();
  }
}

/**
 * orders steps so each follows the steps it needs, keeping the given order
 * where needs leave it free; a settled step is in place already
 * @param steps the plan's steps
 * @param settled steps an earlier plan settled
 * @returns the steps in run order
 * @throws {Error} when an id repeats, a need names no step, or needs form a cycle
 */
function orderSteps(
  steps: readonly SetupStep[],
  settled: readonly string[],
): SetupStep[] {
  const ids = new Set<string>(settled);
  for (const step of steps) {
    if (ids.has(step.id)) {
      throw new Error(`Setup step ${step.id} is declared twice`);
    }
    ids.add(step.id);
  }
  for (const step of steps) {
    const unknown = step.needs.find((need) => !ids.has(need));
    if (unknown !== undefined) {
      throw new Error(`Setup step ${step.id} needs unknown step ${unknown}`);
    }
  }
  const ordered: SetupStep[] = [];
  const placed = new Set<string>(settled);
  while (ordered.length < steps.length) {
    const next = steps.find(
      (step) =>
        !placed.has(step.id) && step.needs.every((need) => placed.has(need)),
    );
    if (!next) {
      const cycle = steps.filter((step) => !placed.has(step.id));
      throw new Error(
        `Setup steps ${cycle.map(({ id }) => id).join(', ')} need each other`,
      );
    }
    ordered.push(next);
    placed.add(next.id);
  }

  return ordered;
}

/**
 * runs one step's check, apply and verify
 * @param slot the plan's session, opened on first use
 * @param step the step to run
 * @returns how the step ended
 */
async function runStep(
  slot: SessionSlot,
  step: SetupStep,
): Promise<StepResult> {
  const session = await slot.session();
  const run = async (command: StepCommand): Promise<GuestExecResult> =>
    session.run(sessionCommand(step, command));
  if (step.check && (await run(step.check)).exitCode === 0) {
    return { status: 'satisfied' };
  }
  const applied = await run(step.apply);
  if (applied.exitCode !== 0) {
    return { status: 'failed', reason: failure('apply', applied) };
  }
  if (step.verify) {
    const verified = await run(step.verify);
    if (verified.exitCode !== 0) {
      return { status: 'failed', reason: failure('verify', verified) };
    }
  }

  return { status: 'applied' };
}

/**
 * fills a step command's account and timeout from its step
 * @param step the step whose account and timeout are the defaults
 * @param command one of the step's check, apply and verify
 * @returns the command with its account and timeout
 */
function sessionCommand(step: SetupStep, command: StepCommand): SessionCommand {
  return {
    ...command,
    account: command.account ?? step.account,
    timeoutMs: command.timeoutMs ?? step.timeoutMs,
  };
}

/**
 * explains a command that exited non-zero
 * @param phase which of the step's commands it was
 * @param result its outcome, already redacted by the session
 * @returns the status and the tail of standard error
 */
function failure(phase: string, result: GuestExecResult): string {
  const detail = result.stderr.trim().slice(-REASON_LENGTH);
  const status = `${phase} exited with status ${result.exitCode}`;

  return detail ? `${status}: ${detail}` : status;
}
