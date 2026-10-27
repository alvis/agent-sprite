import { stdin, stdout, stderr } from 'node:process';

import type { CommandOptions } from '#application/contracts';

/** terminal facts used to choose one interaction mode before execution */
export interface TerminalFacts {
  env: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  rawInputAvailable: boolean;
}

/** prompt mode plus the actual terminal constraint, when implicit */
interface InteractionMode {
  nonInteractive: boolean;
  promptBlocker?: string;
}

/**
 * preserves automation precedence and identifies an implicit prompt blocker
 * @param options parsed mode flags
 * @param options.nonInteractive explicit automation flag
 * @param options.json structured-output flag
 * @param facts effective environment and real terminal capabilities
 * @returns mode decision and a non-secret reason only for terminal limitations
 */
export function resolveInteractionMode(
  options: { nonInteractive?: boolean; json?: boolean },
  facts: TerminalFacts,
): InteractionMode {
  if (
    options.nonInteractive === true ||
    options.json === true ||
    isTruthyEnvironmentValue(facts.env.NON_INTERACTIVE) ||
    isTruthyEnvironmentValue(facts.env.CI)
  ) {
    return { nonInteractive: true };
  }
  const promptBlocker = terminalBlocker(facts);

  return promptBlocker
    ? { nonInteractive: true, promptBlocker }
    : { nonInteractive: false };
}

/**
 * resolves the CLI process streams and selected environment once per command
 * @param options parsed command controls
 * @param modeEnv effective environment after selected credential-file resolution
 * @returns effective options and implicit prompt blocker
 */
export function resolveProcessExecutionOptions(
  options: CommandOptions,
  modeEnv: NodeJS.ProcessEnv,
): { options: CommandOptions; promptBlocker?: string } {
  const mode = resolveInteractionMode(options, {
    env: modeEnv,
    stdinIsTTY: stdin.isTTY === true,
    stdoutIsTTY: stdout.isTTY === true,
    stderrIsTTY: stderr.isTTY === true,
    rawInputAvailable:
      stdin.isTTY === true && typeof stdin.setRawMode === 'function',
  });

  return {
    options: { ...options, nonInteractive: mode.nonInteractive },
    promptBlocker: mode.promptBlocker,
  };
}

/**
 * identifies explicit automation values while excluding unset or false values
 * @param value environment setting
 * @returns whether the setting requests automation
 */
function isTruthyEnvironmentValue(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '');
}

/**
 * selects the first real terminal limitation without blaming automation flags
 * @param facts current stream and terminal capabilities
 * @returns non-secret reason a prompt cannot open
 */
function terminalBlocker(facts: TerminalFacts): string | undefined {
  if (facts.env.TERM === 'dumb') {
    return 'TERM is dumb';
  }
  const requirements: Array<[boolean, string]> = [
    [facts.stdinIsTTY, 'stdin is not a terminal'],
    [facts.stdoutIsTTY, 'stdout is not a terminal'],
    [facts.stderrIsTTY, 'stderr is not a terminal'],
    [facts.rawInputAvailable, 'raw terminal input is unavailable'],
  ];

  return requirements.find(([present]) => !present)?.[1];
}
