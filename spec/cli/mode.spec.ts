import { describe, expect, it } from 'vitest';

import { isNonInteractive, resolveInteractionMode } from '#cli/mode';

import type { TerminalFacts } from '#cli/mode';

const terminal: TerminalFacts = {
  env: {},
  stdinIsTTY: true,
  stdoutIsTTY: true,
  stderrIsTTY: true,
  rawInputAvailable: true,
};

describe('fn:isNonInteractive', () => {
  it('should allow prompts only when every terminal capability is available', () => {
    expect(isNonInteractive({}, terminal)).toBe(false);
    expect(
      isNonInteractive({ nonInteractive: false, json: false }, terminal),
    ).toBe(false);
  });

  it('should force non-interactive mode for explicit output and environment controls', () => {
    const modes = [
      isNonInteractive({ nonInteractive: true }, terminal),
      isNonInteractive({ json: true }, terminal),
      isNonInteractive({}, { ...terminal, env: { NON_INTERACTIVE: 'yes' } }),
      isNonInteractive({}, { ...terminal, env: { CI: 'TRUE' } }),
      isNonInteractive({}, { ...terminal, env: { TERM: 'dumb' } }),
      isNonInteractive({}, { ...terminal, stdinIsTTY: false }),
      isNonInteractive({}, { ...terminal, stdoutIsTTY: false }),
      isNonInteractive({}, { ...terminal, stderrIsTTY: false }),
      isNonInteractive({}, { ...terminal, rawInputAvailable: false }),
    ];

    expect(modes).toEqual(Array<boolean>(9).fill(true));
    expect(
      isNonInteractive(
        {},
        { ...terminal, env: { CI: 'false', NON_INTERACTIVE: '0' } },
      ),
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
