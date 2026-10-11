import { execa } from 'execa';

import { currentOperation, runOperation } from '#operation';

/** local executable invocation with a bounded timeout */
export interface LocalProcessParams {
  program: string;
  arguments: string[];
  timeoutMs?: number;
  trimOutput?: boolean;
}

/** local executable invocation receiving private standard input */
export interface LocalProcessInputParams extends Omit<
  LocalProcessParams,
  'timeoutMs'
> {
  input: string;
  verifyResultExternally?: boolean;
}

const DEFAULT_PROCESS_TIMEOUT_MS = 15_000;

/**
 * runs a local noninteractive program with bounded execution time
 * @param params executable, argument array and maximum execution time
 * @returns trimmed standard output from a successful process
 * @throws {Error} when the process exits unsuccessfully
 */
export async function runLocal(params: LocalProcessParams): Promise<string> {
  const {
    program,
    arguments: arguments_,
    timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
    trimOutput = true,
  } = params;
  const result = await runOperation(async () =>
    execa(program, arguments_, {
      timeout: timeoutMs,
      cancelSignal: currentOperation()?.signal,
      stdin: 'ignore',
      stderr: 'pipe',
      stdout: 'pipe',
      reject: false,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GH_PROMPT_DISABLED: '1',
      },
    }),
  );
  if (result.exitCode !== 0) {
    throw new Error(`${program} failed (${result.exitCode ?? 'timeout'})`);
  }

  return trimOutput ? result.stdout.trim() : result.stdout;
}

/**
 * sends private input to a local program without shell interpolation
 * @param params executable, argument array and private standard input
 * @throws {Error} when the process exits unsuccessfully
 */
export async function sendLocalInput(
  params: LocalProcessInputParams,
): Promise<void> {
  const {
    program,
    arguments: arguments_,
    input,
    verifyResultExternally,
  } = params;
  const result = await runOperation(async () =>
    execa(program, arguments_, {
      input,
      timeout: DEFAULT_PROCESS_TIMEOUT_MS,
      cancelSignal: currentOperation()?.signal,
      stdout: 'ignore',
      stderr: 'pipe',
      reject: false,
    }),
  );
  if (result.exitCode !== 0 && !verifyResultExternally) {
    throw new Error(`${program} failed (${result.exitCode ?? 'timeout'})`);
  }
}
