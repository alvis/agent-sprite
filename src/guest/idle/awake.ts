import { pathToFileURL } from 'node:url';

import {
  AWAKE_DEADLINE_MS,
  parseAwakeArguments,
  USAGE_EXIT_CODE,
} from './command.js';
import { productionContext, rootOfModule } from './context.js';
import { handleAwakeEvent, recordGovernorState } from './governor.js';
import { hookInputWaitMs, readHookSession } from './hook-input.js';

import type { AwakeEvent, AwakeInvocation } from './command.js';
import type { GovernorContext } from './context.js';

// guest kernel: imports only Node built-ins and other guest code, and names no
// provider. The entry of `open-agent-awake`: harness hooks run it as the agent
// account and managed operations as root. It never fails a turn: it exits 0,
// within its run budget (`--budget-ms`, else AWAKE_DEADLINE_MS), whatever
// happens after a known action, and a write that fails counts as idleness.
// The holder write lands before any deadline apply starts, so a budget too
// short for the apply still records the event. Only a command line without a
// known action exits USAGE_EXIT_CODE, because no hook sends one, so no turn
// waits on it

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runAwakeProcess(
    process.argv.slice(2),
    async () => productionContext(rootOfModule(import.meta.url)),
    process.stdin,
  );
}

/**
 * runs one awake command line as the whole process and ends the process with
 * its status, or with status 0 once the command line's run budget has passed
 * @param args command arguments after the program name
 * @param context builds the governor context once the action is known
 * @param input the hook's standard input, read only for `--session -`
 */
export async function runAwakeProcess(
  args: readonly string[],
  context: () => Promise<GovernorContext>,
  input: AsyncIterable<Buffer | string>,
): Promise<void> {
  const invocation = parseAwakeArguments(args);
  // a hung adapter or filesystem must not hold a hook past its budget
  setTimeout(
    () => process.exit(0),
    'usage' in invocation ? AWAKE_DEADLINE_MS : invocation.budgetMs,
  ).unref();
  const status = await runAwakeCommand(invocation, context, input);
  // an adapter may leave sockets or timers open; the event is complete
  process.exit(status);
}

/**
 * runs one parsed awake command line
 * @param invocation the parsed command line
 * @param context builds the governor context once the action is known
 * @param input the hook's standard input, read only for `--session -`, and
 * waited for at most a share of the run budget
 * @returns USAGE_EXIT_CODE for a command line without a known action, else 0
 */
export async function runAwakeCommand(
  invocation: AwakeInvocation,
  context: () => Promise<GovernorContext>,
  input: AsyncIterable<Buffer | string>,
): Promise<number> {
  if ('usage' in invocation) {
    process.stderr.write(`${invocation.usage}\n`);

    return USAGE_EXIT_CODE;
  }
  try {
    const governor = await context();
    const resolved = await resolveEvent(invocation, input);
    await ('event' in resolved
      ? handleAwakeEvent(governor, resolved.event)
      : recordGovernorState(governor, [
          `refused an awake event: ${resolved.refused}`,
        ]));
  } catch {
    // the event is lost, which the governor treats as idleness
  }

  return 0;
}

/**
 * completes a hook's event with the session identifier on its input
 * @param invocation a parsed command line that is not a usage error
 * @param input the hook's standard input
 * @returns the event to record, or why the command line or the input is refused
 */
async function resolveEvent(
  invocation: Exclude<AwakeInvocation, { usage: string }>,
  input: AsyncIterable<Buffer | string>,
): Promise<{ event: AwakeEvent } | { refused: string }> {
  if (!('hook' in invocation)) {
    return invocation;
  }
  const read = await readHookSession(
    input,
    hookInputWaitMs(invocation.budgetMs),
  );

  return 'session' in read
    ? { event: { ...invocation.hook, session: read.session } }
    : read;
}
