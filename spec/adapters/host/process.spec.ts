import { describe, expect, it, vi } from 'vitest';

import { runLocal, sendLocalInput } from '#adapters/host/process';
import { OperationContext, withOperation } from '#kernel/operation';

import type { Options, Result, ResultPromise } from 'execa';

const { execa } = vi.hoisted(() => ({
  execa: vi.fn<
    (
      program: string,
      args: readonly string[],
      options?: Options,
    ) => ResultPromise
  >(
    (): ResultPromise =>
      Promise.resolve({
        exitCode: 0,
        stdout: '  generated output\n',
      } satisfies Partial<Result> as Result) as ResultPromise,
  ),
}));

vi.mock('execa', () => {
  return {
    execa: execa as typeof execa & typeof import('execa').execa,
  } satisfies Partial<typeof import('execa')>;
});

describe('fn:runLocal', () => {
  it('should trim output and disable interactive prompts for unscoped execution', async () => {
    const output = await runLocal({
      program: 'generated-program',
      arguments: ['status'],
    });

    expect(output).toBe('generated output');
    expect(execa.mock.calls).toEqual([
      [
        'generated-program',
        ['status'],
        {
          timeout: 15_000,
          cancelSignal: undefined,
          stdin: 'ignore',
          stderr: 'pipe',
          stdout: 'pipe',
          reject: false,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GH_PROMPT_DISABLED: '1',
          },
        },
      ],
    ]);
  });

  it('should preserve raw output and the caller timeout inside an operation', async () => {
    const context = new OperationContext({
      signal: new AbortController().signal,
    });

    const output = await withOperation(context, async () =>
      runLocal({
        program: 'generated-program',
        arguments: [],
        timeoutMs: 100,
        trimOutput: false,
      }),
    );

    expect(output).toBe('  generated output\n');
    expect(execa.mock.calls).toEqual([
      [
        'generated-program',
        [],
        expect.objectContaining({ timeout: 100, cancelSignal: context.signal }),
      ],
    ]);
  });

  it.each([
    { name: 'exit', result: { exitCode: 2 }, reason: '(2)' },
    { name: 'timeout', result: {}, reason: '(timeout)' },
  ])(
    'should reject a process $name without returning its output',
    async ({ result, reason }) => {
      execa.mockReturnValueOnce(
        Promise.resolve(
          result satisfies Partial<Result> as Result,
        ) as ResultPromise,
      );

      await expect(
        runLocal({ program: 'generated-program', arguments: [] }),
      ).rejects.toEqual(
        expect.objectContaining({ message: expect.stringContaining(reason) }),
      );
    },
  );
});

describe('fn:sendLocalInput', () => {
  it('should deliver private standard input through the active operation', async () => {
    const context = new OperationContext({
      signal: new AbortController().signal,
    });

    await expect(
      withOperation(context, async () =>
        sendLocalInput({
          program: 'generated-program',
          arguments: ['-i'],
          input: 'generated-secret',
        }),
      ),
    ).resolves.toBeUndefined();

    expect(execa.mock.calls).toEqual([
      [
        'generated-program',
        ['-i'],
        {
          input: 'generated-secret',
          timeout: 15_000,
          cancelSignal: context.signal,
          stdout: 'ignore',
          stderr: 'pipe',
          reject: false,
        },
      ],
    ]);
  });

  it.each([
    { name: 'exit', result: { exitCode: 2 }, reason: '(2)' },
    { name: 'timeout', result: {}, reason: '(timeout)' },
  ])(
    'should reject an unverified input delivery $name',
    async ({ result, reason }) => {
      execa.mockReturnValueOnce(
        Promise.resolve(
          result satisfies Partial<Result> as Result,
        ) as ResultPromise,
      );

      await expect(
        sendLocalInput({
          program: 'generated-program',
          arguments: [],
          input: 'generated-secret',
        }),
      ).rejects.toEqual(
        expect.objectContaining({ message: expect.stringContaining(reason) }),
      );
    },
  );

  it('should defer unsuccessful delivery verification when the caller will read back externally', async () => {
    execa.mockReturnValueOnce(
      Promise.resolve({
        exitCode: 2,
      } satisfies Partial<Result> as Result) as ResultPromise,
    );

    await expect(
      sendLocalInput({
        program: 'generated-program',
        arguments: [],
        input: 'generated-secret',
        verifyResultExternally: true,
      }),
    ).resolves.toBeUndefined();
  });
});
