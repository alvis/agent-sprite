import { vi } from 'vitest';

import type { ReleaseInstallTools } from '#drivers/install-sources';
import type { RunTool } from '#guest/install-tools/agent';

const RUNUSER = '/usr/sbin/runuser';

/** the guest program that ran, with the account switch around it removed */
export type RanProgram = string[];

/**
 * builds the installer helpers with inert defaults a test overrides
 * @param overrides helpers the test behaviour depends on
 * @returns helpers that record what a component installer asks of the guest
 */
export function toolsWith(
  overrides: Partial<ReleaseInstallTools> = {},
): ReleaseInstallTools {
  return {
    download: vi.fn<ReleaseInstallTools['download']>(async () => undefined),
    downloadText: vi.fn<ReleaseInstallTools['downloadText']>(async () => ''),
    link: vi.fn<ReleaseInstallTools['link']>(async () => undefined),
    run: vi.fn<RunTool>(async () => ''),
    temporary: '/scratch',
    toolsDirectory: '/opt/open-agent/tools',
    ...overrides,
  };
}

/** what a program prints, or the failure it raises */
type Answer = string | Error;

/**
 * builds a runner that answers every version probe from a table and succeeds
 * for every other program
 * @param probes output (or failure) per program a probe starts, keyed by its argv joined by spaces; a list answers each start in turn and repeats its last answer
 * @returns a recording runner
 */
export function runnerFor(
  probes: Record<string, Answer | Answer[]>,
): ReturnType<typeof vi.fn<RunTool>> {
  const starts = new Map<string, number>();

  return vi.fn<RunTool>(async (executable, args) => {
    const program = programOf(executable, args).join(' ');
    const planned = probes[program];
    const count = starts.get(program) ?? 0;
    starts.set(program, count + 1);
    const answer = Array.isArray(planned)
      ? planned[Math.min(count, planned.length - 1)]
      : planned;
    if (answer instanceof Error) {
      throw answer;
    }

    return answer ?? '';
  });
}

/**
 * lists the programs a runner was asked to start, in order
 * @param run runner returned by `runnerFor`
 * @returns each program with its arguments, as the guest would execute it
 */
export function ranPrograms(
  run: ReturnType<typeof vi.fn<RunTool>>,
): RanProgram[] {
  return run.mock.calls.map(([executable, args]) =>
    programOf(executable, args),
  );
}

/**
 * strips the account switch from a program started as the agent
 * @param executable program the runner was given
 * @param args its arguments
 * @returns the program and its arguments
 */
export function programOf(
  executable: string,
  args: readonly string[],
): RanProgram {
  if (executable !== RUNUSER) {
    return [executable, ...args];
  }

  return args.slice(args.findIndex((arg) => arg.startsWith('PATH=')) + 1);
}
