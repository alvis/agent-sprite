import { describe, expect, it, vi } from 'vitest';

import {
  resolveInteractionMode,
  resolveProcessExecutionOptions,
} from '#cli/mode';

import type { TerminalFacts } from '#cli/mode';

type ProcessModule = typeof import('node:process');

// mode resolution reads terminal facts without consuming stream operations
// typed partial fixtures keep this boundary independent of live process streams
vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<ProcessModule>();
  const input: Partial<ProcessModule['stdin']> = {
    isTTY: true,
    setRawMode: () => actual.stdin,
  };
  const output: Partial<ProcessModule['stdout']> = { isTTY: true };
  const error: Partial<ProcessModule['stderr']> = { isTTY: true };

  return {
    ...actual,
    stdin: input as ProcessModule['stdin'],
    stdout: output as ProcessModule['stdout'],
    stderr: error as ProcessModule['stderr'],
  } satisfies Partial<ProcessModule>;
});

const terminal: TerminalFacts = {
  env: {},
  stdinIsTTY: true,
  stdoutIsTTY: true,
  stderrIsTTY: true,
  rawInputAvailable: true,
};

describe('fn:resolveInteractionMode prompt decision', () => {
  it('should allow prompts only when every terminal capability is available', () => {
    expect(resolveInteractionMode({}, terminal).nonInteractive).toBe(false);
    expect(
      resolveInteractionMode({ nonInteractive: false, json: false }, terminal)
        .nonInteractive,
    ).toBe(false);
  });

  it('should force non-interactive mode for explicit output and environment controls', () => {
    const modes = [
      resolveInteractionMode({ nonInteractive: true }, terminal).nonInteractive,
      resolveInteractionMode({ json: true }, terminal).nonInteractive,
      resolveInteractionMode(
        {},
        { ...terminal, env: { NON_INTERACTIVE: 'yes' } },
      ).nonInteractive,
      resolveInteractionMode({}, { ...terminal, env: { CI: 'TRUE' } })
        .nonInteractive,
      resolveInteractionMode({}, { ...terminal, env: { TERM: 'dumb' } })
        .nonInteractive,
      resolveInteractionMode({}, { ...terminal, stdinIsTTY: false })
        .nonInteractive,
      resolveInteractionMode({}, { ...terminal, stdoutIsTTY: false })
        .nonInteractive,
      resolveInteractionMode({}, { ...terminal, stderrIsTTY: false })
        .nonInteractive,
      resolveInteractionMode({}, { ...terminal, rawInputAvailable: false })
        .nonInteractive,
    ];

    expect(modes).toEqual(Array<boolean>(9).fill(true));
    expect(
      resolveInteractionMode(
        {},
        { ...terminal, env: { CI: 'false', NON_INTERACTIVE: '0' } },
      ).nonInteractive,
    ).toBe(false);
  });
});

describe('fn:resolveInteractionMode', () => {
  it.each([
    { facts: { env: { TERM: 'dumb' } }, reason: 'TERM is dumb' },
    { facts: { stdinIsTTY: false }, reason: 'stdin is not a terminal' },
    { facts: { stdoutIsTTY: false }, reason: 'stdout is not a terminal' },
    { facts: { stderrIsTTY: false }, reason: 'stderr is not a terminal' },
    {
      facts: { rawInputAvailable: false },
      reason: 'raw terminal input is unavailable',
    },
  ])('should identify the implicit $reason blocker', ({ facts, reason }) => {
    expect(resolveInteractionMode({}, { ...terminal, ...facts })).toEqual({
      nonInteractive: true,
      promptBlocker: reason,
    });
  });

  it.each([
    { options: { json: true }, env: {} },
    { options: { nonInteractive: true }, env: {} },
    { options: {}, env: { CI: 'true' } },
    { options: {}, env: { NON_INTERACTIVE: '1' } },
  ])(
    'should avoid blaming a terminal when automation was explicitly selected',
    ({ options, env }) => {
      expect(
        resolveInteractionMode(options, {
          ...terminal,
          env: { ...env, TERM: 'dumb' },
          stderrIsTTY: false,
        }),
      ).toEqual({ nonInteractive: true });
    },
  );

  it('should keep NO_COLOR independent of the prompt decision', () => {
    expect(
      resolveInteractionMode({}, { ...terminal, env: { NO_COLOR: '1' } }),
    ).toEqual({ nonInteractive: false });
  });
});

describe('fn:resolveProcessExecutionOptions', () => {
  it('should allow prompts when the process boundary supplies raw terminal streams', () => {
    expect(resolveProcessExecutionOptions({}, {})).toEqual({
      options: { nonInteractive: false },
      promptBlocker: undefined,
    });
  });
});
