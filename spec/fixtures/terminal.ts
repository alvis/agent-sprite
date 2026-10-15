import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { spawn } from 'node-pty';

const execFileAsync = promisify(execFile);

/** Input sent after a matching prompt appears on a real terminal. */
export interface TerminalStep {
  waitFor: string;
  input?: string;
  signal?: NodeJS.Signals;
}

/** Options for a real terminal process. */
export interface TerminalOptions {
  args?: string[];
  columns?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  readinessMarker?: string;
  /** maximum wait for each pending prompt; the overall timeout still applies */
  stepTimeout?: number;
  waitForRaw?: boolean;
  timeout?: number;
}

/** Captured terminal output and process outcome. */
export interface TerminalResult {
  elapsedMs: number;
  exitCode: number;
  matchedSteps: number;
  output: string;
  stepTimes: number[];
  timedOut: boolean;
}

/**
 * Spawn an executable with a native PTY and wait for prompts before typing.
 * @param executable installed executable to spawn
 * @param steps prompt and input sequence to drive
 * @param options terminal settings and readiness conditions
 */
export async function runTerminal(
  executable: string,
  steps: TerminalStep[],
  options: TerminalOptions = {},
): Promise<TerminalResult> {
  const terminal = spawn(executable, options.args ?? [], {
    name: 'xterm-256color',
    cols: options.columns ?? 80,
    rows: 24,
    cwd: options.cwd ?? process.cwd(),
    env: { ...(options.env ?? process.env), TERM: 'xterm-256color' },
  });

  return new Promise((resolveResult) => {
    const started = performance.now();
    let output = '';
    let matchedSteps = 0;
    const stepTimes: number[] = [];
    let searchFrom = 0;
    let timedOut = false;
    let waitingForInput = false;
    let closed = false;
    let device: Promise<string> | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    const send = (step: TerminalStep): void => {
      if (step.signal) {
        terminal.kill(step.signal);
      } else {
        terminal.write(step.input ?? '');
      }
    };
    let stall: NodeJS.Timeout | undefined;
    const expire = (): void => {
      timedOut = true;
      terminal.kill('SIGTERM');
      forceKill = setTimeout(() => terminal.kill('SIGKILL'), 1_000);
    };
    const deadline = setTimeout(expire, options.timeout ?? 15_000);
    const armStall = (): void => {
      clearTimeout(stall);
      stall =
        options.stepTimeout && matchedSteps < steps.length
          ? setTimeout(expire, options.stepTimeout)
          : undefined;
    };
    armStall();

    const sendReadyInput = async (step: TerminalStep): Promise<void> => {
      if (options.waitForRaw) {
        device ??= execFileAsync('ps', [
          '-o',
          'tty=',
          '-p',
          String(terminal.pid),
        ]).then(({ stdout }) => `/dev/${stdout.trim()}`);
        const tty = await device;
        const binary = process.platform === 'darwin' ? '/bin/stty' : 'stty';
        const args =
          process.platform === 'darwin' ? ['-f', tty, '-a'] : ['-F', tty, '-a'];
        while (!closed) {
          const { stdout } = await execFileAsync(binary, args);
          if (
            /\s-icanon\s/u.test(` ${stdout} `) &&
            /\s-echo\s/u.test(` ${stdout} `)
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      if (!closed) {
        send(step);
      }
    };
    const advance = (): void => {
      if (waitingForInput || closed) {
        return;
      }
      while (matchedSteps < steps.length) {
        const step = steps[matchedSteps];
        if (!step) {
          break;
        }
        const position = output.indexOf(step.waitFor, searchFrom);
        if (position < 0) {
          break;
        }
        const next = position + step.waitFor.length;
        if (options.readinessMarker) {
          const ready = output.indexOf(options.readinessMarker, next);
          if (ready < 0) {
            break;
          }
          searchFrom = ready + options.readinessMarker.length;
        } else {
          searchFrom = next;
        }
        if (!options.waitForRaw) {
          matchedSteps++;
          stepTimes.push(performance.now() - started);
          armStall();
          send(step);
          continue;
        }
        waitingForInput = true;
        void sendReadyInput(step)
          .then(() => {
            if (!closed) {
              matchedSteps++;
              stepTimes.push(performance.now() - started);
              armStall();
            }
            waitingForInput = false;
            advance();
          })
          .catch((error: unknown) => {
            output += `\n[terminal readiness error] ${String(error)}`;
            timedOut = true;
            terminal.kill('SIGTERM');
          });
        break;
      }
    };
    terminal.onData((chunk) => {
      output += chunk;
      advance();
    });

    terminal.onExit(({ exitCode }) => {
      closed = true;
      clearTimeout(deadline);
      clearTimeout(stall);
      clearTimeout(forceKill);
      resolveResult({
        elapsedMs: performance.now() - started,
        exitCode,
        matchedSteps,
        output,
        stepTimes,
        timedOut,
      });
    });
  });
}
