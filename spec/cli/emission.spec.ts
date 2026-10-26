import process from 'node:process';

import { describe, expect, it, vi } from 'vitest';

import { emitResult } from '#cli/emission';

import type { MachineSummary } from '#application/machine';
import type { CommandResult } from '#application/result';
import type { ExecutionState } from '#cli/parser';

const MACHINE = {
  id: 'machine-1',
  name: 'dev box',
  organization: 'test',
  state: 'running',
  setup: 'incomplete',
  readiness: 'not inspected',
} satisfies MachineSummary;

/**
 * creates one un-emitted command state
 * @param command selected command identity
 * @returns fresh invocation-local state
 */
function state(command: ExecutionState['command']): ExecutionState {
  return { command, emitted: false, errors: [] };
}

/**
 * creates a machine with an unreadable presentation field
 * @param setup provider-recorded setup state
 * @returns machine whose unreadable state fails the first projection
 */
function machineWithUnreadableState(
  setup: MachineSummary['setup'],
): MachineSummary {
  return {
    ...MACHINE,
    setup,
    get state(): string {
      throw new Error('unreadable machine state');
    },
  };
}

/**
 * captures one real emission at the process stream boundary
 * @param action emission to observe
 * @returns complete output and exact exit status
 */
function captureEmission(action: () => void): {
  stdout: string;
  stderr: string;
  exitCode: typeof process.exitCode;
} {
  const originalExitCode = process.exitCode;
  let stdout = '';
  let stderr = '';
  using output = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((...args) => {
      stdout += String(args[0]);
      args.find(
        (argument): argument is () => void => typeof argument === 'function',
      )?.();

      return true;
    });
  using errors = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((...args) => {
      stderr += String(args[0]);
      args.find(
        (argument): argument is () => void => typeof argument === 'function',
      )?.();

      return true;
    });
  void output;
  void errors;
  try {
    action();

    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.exitCode = originalExitCode;
  }
}

describe('fn:emitResult', () => {
  it('should render one input failure and set the exact exit code', () => {
    const result: CommandResult = {
      command: 'show',
      ok: false,
      error: { code: 'INPUT', message: 'bad input' },
    };
    const invocation = state('show');

    const output = captureEmission(() => {
      emitResult({ result, options: {}, state: invocation });
      emitResult({ result, options: {}, state: invocation });
    });

    expect({ ...output, emitted: invocation.emitted }).toEqual({
      stdout: '',
      stderr: 'bad input\n',
      exitCode: 1,
      emitted: true,
    });
  });

  it('should render a JSON list with zero exit code', () => {
    const result: CommandResult = {
      command: 'list',
      ok: true,
      data: { machines: [], unavailable: [] },
    };
    const invocation = state('list');

    const output = captureEmission(() =>
      emitResult({ result, options: { json: true }, state: invocation }),
    );

    expect({
      result: JSON.parse(output.stdout),
      newline: output.stdout.endsWith('\n'),
      stderr: output.stderr,
      exitCode: output.exitCode,
      emitted: invocation.emitted,
    }).toEqual({
      result: {
        schemaVersion: 1,
        command: 'list',
        ok: true,
        data: { machines: [], unavailable: [] },
      },
      newline: true,
      stderr: '',
      exitCode: 0,
      emitted: true,
    });
  });

  it('should write cancellation to stderr with exit code 130', () => {
    const result: CommandResult = {
      command: 'show',
      ok: false,
      error: { code: 'CANCELLED', message: 'Cancelled by user' },
    };
    const invocation = state('show');

    const output = captureEmission(() =>
      emitResult({ result, options: {}, state: invocation }),
    );

    expect({ ...output, emitted: invocation.emitted }).toEqual({
      stdout: '',
      stderr: 'Cancelled by user\n',
      exitCode: 130,
      emitted: true,
    });
  });

  it('should convert an unreadable error into one JSON recovery result', () => {
    const result: CommandResult = {
      command: 'show',
      ok: false,
      error: {
        code: 'INPUT',
        get message(): string {
          throw new Error('private render failure');
        },
        machine: 'dev box',
        machineId: 'machine-1',
        setupIncomplete: true,
        outcome: 'unknown',
        details: ['Inspect provider state.'],
      },
    };
    const invocation = state('show');

    const output = captureEmission(() => {
      emitResult({ result, options: { json: true }, state: invocation });
      emitResult({ result, options: { json: true }, state: invocation });
    });

    expect({
      result: JSON.parse(output.stdout),
      newline: output.stdout.endsWith('\n'),
      stderr: output.stderr,
      exitCode: output.exitCode,
      emitted: invocation.emitted,
    }).toEqual({
      result: {
        schemaVersion: 1,
        command: 'show',
        ok: false,
        error: {
          code: 'UNEXPECTED',
          message: expect.any(String),
          machine: 'dev box',
          machineId: 'machine-1',
          setupIncomplete: true,
          outcome: 'unknown',
          details: ['Inspect provider state.'],
        },
      },
      newline: true,
      stderr: '',
      exitCode: 1,
      emitted: true,
    });
  });

  it('should retain workstation identity in human render recovery', () => {
    const result: CommandResult = {
      command: 'show',
      ok: false,
      error: {
        code: 'INPUT',
        get message(): string {
          throw new Error('private render failure');
        },
        machine: 'dev box',
        machineId: 'machine-1',
        setupIncomplete: true,
        outcome: 'unknown',
        details: ['Inspect provider state.'],
      },
    };
    const invocation = state('show');

    const output = captureEmission(() =>
      emitResult({ result, options: {}, state: invocation }),
    );

    expect({ ...output, emitted: invocation.emitted }).toEqual({
      stdout: '',
      stderr: expect.stringMatching(
        /dev box[\s\S]*machine-1[\s\S]*incomplete[\s\S]*Inspect provider state\./,
      ),
      exitCode: 1,
      emitted: true,
    });
  });

  it.each([
    {
      label: 'show incomplete',
      result: {
        command: 'show',
        ok: true,
        data: { machine: machineWithUnreadableState('incomplete') },
      } satisfies CommandResult,
      recovery: {
        machine: 'dev box',
        machineId: 'machine-1',
        setupIncomplete: true,
        outcome: 'unknown',
        details: ['Inspect: open-agent show "dev box" --inspect'],
      },
    },
    {
      label: 'show ready',
      result: {
        command: 'show',
        ok: true,
        data: { machine: machineWithUnreadableState('ready') },
      } satisfies CommandResult,
      recovery: {
        machine: 'dev box',
        machineId: 'machine-1',
        outcome: 'unknown',
        details: ['Inspect: open-agent show "dev box" --inspect'],
      },
    },
    {
      label: 'terminate',
      result: {
        command: 'terminate',
        ok: true,
        data: {
          machine: MACHINE,
          workstation: {
            status: 'deleted',
            id: 'machine-1',
            name: 'dev box',
          },
          network: {
            get status(): 'cleanup required' {
              throw new Error('unreadable network status');
            },
          },
        },
      } satisfies CommandResult,
      recovery: {
        machine: 'dev box',
        machineId: 'machine-1',
        setupIncomplete: true,
        outcome: 'unknown',
        details: [
          'Workstation deleted; verify network cleanup before retrying.',
        ],
      },
    },
    {
      label: 'list',
      result: {
        command: 'list',
        ok: true,
        data: {
          machines: [
            {
              ...MACHINE,
              provider: 'sprite',
              get state(): string {
                throw new Error('unreadable listed state');
              },
            },
          ],
          unavailable: [],
        },
      } satisfies CommandResult,
      recovery: {},
    },
    {
      label: 'setup local credential',
      result: {
        command: 'setup',
        ok: true,
        data: {
          localCredential: {
            get status(): 'replaced' {
              throw new Error('unreadable credential status');
            },
            scope: 'this computer; all workstations',
          },
        },
      } satisfies CommandResult,
      recovery: {},
    },
    {
      label: 'setup workstation',
      result: {
        command: 'setup',
        ok: true,
        data: {
          section: 'git',
          gitIdentity: 'configured',
          machine: machineWithUnreadableState('incomplete'),
        },
      } satisfies CommandResult,
      recovery: {
        machine: 'dev box',
        machineId: 'machine-1',
        setupIncomplete: true,
        outcome: 'unknown',
        details: ['Inspect: open-agent show "dev box" --inspect'],
      },
    },
  ])(
    'should retain $label recovery from success render failure',
    ({ result, recovery }) => {
      const invocation = state(result.command);

      const output = captureEmission(() =>
        emitResult({ result, options: { json: true }, state: invocation }),
      );

      expect({
        result: JSON.parse(output.stdout),
        newline: output.stdout.endsWith('\n'),
        stderr: output.stderr,
        exitCode: output.exitCode,
        emitted: invocation.emitted,
      }).toEqual({
        result: {
          schemaVersion: 1,
          command: result.command,
          ok: false,
          error: {
            code: 'UNEXPECTED',
            message: expect.any(String),
            ...recovery,
          },
        },
        newline: true,
        stderr: '',
        exitCode: 1,
        emitted: true,
      });
    },
  );
});
