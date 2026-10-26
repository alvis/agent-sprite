import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { commandError } from '#application/failures';
import { resolveSecret } from '#application/input/sources';
import { withBackNavigation } from '#application/navigation';
import { resultExitCode } from '#cli/exit';

import { createInteraction } from '#cli/interaction';
import { createStageReporter } from '#cli/reporting';

import { InteractionExit, returnOnBack } from '#kernel/navigation';

import { driveInk } from '../fixtures/ink';
import { dependencies } from '../mocks/dependencies';

describe('fn:createInteraction', () => {
  it('should suppress routine quiet-mode status while keeping warnings and errors visible', async () => {
    const controller = new AbortController();
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => input,
    });
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
      rows: 24,
    });
    let captured = '';
    output.on('data', (chunk: Buffer) => {
      captured += chunk.toString();
    });
    const session = createInteraction(
      true,
      { stdin: input, stderr: output },
      {
        signal: controller.signal,
        cancel: () => controller.abort(),
        interrupt: () => controller.abort(),
        quiet: true,
      },
    );
    try {
      session.status({ kind: 'info', message: 'routine-info' });
      session.status({ kind: 'success', message: 'routine-success' });
      session.status({ kind: 'warning', message: 'visible-warning' });
      session.status({ kind: 'error', message: 'visible-error' });

      await vi.waitFor(() => {
        expect({
          info: captured.includes('routine-info'),
          success: captured.includes('routine-success'),
          warning: captured.includes('visible-warning'),
          error: captured.includes('visible-error'),
        }).toEqual({ info: false, success: false, warning: true, error: true });
      });
    } finally {
      await session.dispose();
      input.destroy();
      output.destroy();
    }
  });

  it('should reject active and queued prompts on disposal and refuse later prompts', async () => {
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => input,
    });
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
      rows: 24,
    });
    const session = createInteraction(true, { stdin: input, stderr: output });
    try {
      const pending = Promise.allSettled([
        session.input({ message: 'Active prompt' }),
        session.input({ message: 'Queued prompt' }),
      ]);

      await session.dispose();

      expect(await settleWithin(pending)).toEqual([
        { status: 'rejected', reason: new InteractionExit('cancel') },
        { status: 'rejected', reason: new InteractionExit('cancel') },
      ]);
      await expect(
        session.input({ message: 'After disposal' }),
      ).rejects.toEqual(new InteractionExit('cancel'));
    } finally {
      await session.dispose();
      input.destroy();
      output.destroy();
    }
  });

  it('should refuse prompts in a cancellation scope that was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => input,
    });
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
      rows: 24,
    });
    const session = createInteraction(
      true,
      { stdin: input, stderr: output },
      {
        signal: controller.signal,
        cancel: () => controller.abort(),
        interrupt: () => controller.abort(),
      },
    );
    try {
      const pending = session.secret({ message: 'Never display this prompt' });

      expect(await settleWithin(Promise.allSettled([pending]))).toEqual([
        { status: 'rejected', reason: new InteractionExit('cancel') },
      ]);
      expect(String(output.read())).not.toContain('Never display this prompt');
    } finally {
      await session.dispose();
      input.destroy();
      output.destroy();
    }
  });

  it.each([
    { action: 'interrupt', input: '\x03', exit: 'cancel' },
    { action: 'cancel with Escape', input: '\x1b', exit: 'back' },
  ])(
    'should $action a multiple-choice prompt without submitting a selection',
    async ({ input, exit }) => {
      const observed = await driveInk(
        async (interaction) =>
          settleWithin(
            interaction
              .multiselect(
                { message: 'Cancelable plugins', backLabel: 'plugin menu' },
                [{ label: 'Plugin', value: 'plugin' }],
              )
              .then(
                () => ({ submitted: true }),
                (error: unknown) => ({
                  submitted: false,
                  code: commandError(error).code,
                  exit: error,
                }),
              ),
          ),
        [{ waitFor: 'Cancelable plugins', input }],
      );

      expect(observed.matchedSteps).toBe(1);
      expect(observed.result).toHaveProperty('submitted', false);
      if (exit === 'cancel') {
        expect(observed.result).toHaveProperty('code', 'CANCELLED');
      }
      expect(observed.result).toHaveProperty('exit.action', exit);
      if (exit === 'back') {
        const withoutParent = await driveInk(
          async (interaction) =>
            settleWithin(
              interaction
                .multiselect({ message: 'No parent choice' }, [
                  { label: 'Plugin', value: 'plugin' },
                ])
                .catch((error: unknown) => error),
            ),
          [{ waitFor: 'No parent choice', input: '\x1b' }],
        );

        expect(withoutParent.matchedSteps).toBe(1);
        expect(withoutParent.result).toHaveProperty('action', 'cancel');
      }
    },
  );

  it('should accept a secret without exposing it while a live stage remains visible', async () => {
    const secretValue = 'private-value-not-for-display';
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => input,
    });
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
      rows: 24,
    });
    let captured = '';
    output.on('data', (chunk: Buffer) => {
      captured += chunk.toString();
    });
    const session = createInteraction(true, { stdin: input, stderr: output });
    let pending: Promise<string> | undefined;

    try {
      session.progress({
        stage: 'credentials',
        message: 'Awaiting credential',
        phase: 'start',
      });
      pending = session.secret({
        message: 'Private credential',
        description: 'Only the consumer receives this value',
        required: true,
      });
      void pending.catch(() => undefined);
      await vi.waitFor(() => {
        expect(captured).toContain('Private credential');
        expect(captured).toContain('\x1b[?2026l');
      });

      input.write(secretValue);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(captured).not.toContain(secretValue);

      input.write('\r');
      expect(await pending).toBe(secretValue);
      session.progress({
        stage: 'credentials',
        message: 'Credential accepted',
        phase: 'complete',
        outcome: 'ok',
      });
      await vi.waitFor(() => expect(captured).toContain('credentials'));
    } finally {
      await session.dispose();
      await pending?.catch(() => undefined);
      input.destroy();
      output.destroy();
    }
  });

  it('should redact registered credentials in real Ink status and progress output', async () => {
    const secret = await resolveSecret(
      dependencies,
      undefined,
      'saf08-ink-status-key',
    );
    const observed = await driveInk(async (interaction) => {
      interaction.status({ kind: 'warning', message: `Rejected ${secret}` });
      interaction.progress({
        stage: 'create',
        message: `Retry without ${secret}`,
      });
    }, []);

    expect(observed.output).toContain('Rejected [REDACTED]');
    expect(observed.output).toContain('Retry without [REDACTED]');
    expect(observed.output).not.toContain(secret);
  });

  it('should show successive selection and confirmation prompts under inherited CI markers', async () => {
    vi.stubEnv('CI', '');
    vi.stubEnv('NON_INTERACTIVE', 'false');
    vi.stubEnv('CONTINUOUS_INTEGRATION', '1');

    const observed = await driveInk(
      async (interaction) => {
        const selected = await interaction.select(
          { message: 'Select a workstation' },
          [{ label: 'primary workstation', value: 'primary' }],
        );
        const confirmed = await interaction.confirm({
          message: 'Inspect selected workstation?',
        });

        return { selected, confirmed };
      },
      [
        { waitFor: 'primary workstation', input: '\r' },
        { waitFor: 'Inspect selected workstation?', input: 'y' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(2);
    expect(observed.result).toEqual({ selected: 'primary', confirmed: true });
  });

  it('should carry literal choice values through real selection and back navigation', async () => {
    const choices = [
      { label: 'Claude harness', value: 'claude' },
      { label: 'Codex harness', value: 'codex' },
    ] as const;
    const consumeHarness = (harness: 'claude' | 'codex') => harness;
    const observed = await driveInk(
      async (interaction) => {
        const nested = withBackNavigation(interaction, 'harness menu');
        const selected = consumeHarness(
          await nested.select({ message: 'Choose a harness' }, choices),
        );
        const selectedMany = (
          await nested.multiselect({ message: 'Choose harnesses' }, choices)
        ).map(consumeHarness);

        return { selected, selectedMany };
      },
      [
        { waitFor: 'Choose a harness', input: '\r' },
        { waitFor: 'Choose harnesses', input: ' ' },
        { waitFor: '1 selected', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(3);
    expect(observed.result).toEqual({
      selected: 'claude',
      selectedMany: ['claude'],
    });
    expect(observed.output).toContain('Esc harness menu');
  });

  it('should treat Escape as local back but Ctrl-C as process cancellation', async () => {
    const back = await driveInk(
      async (interaction) =>
        returnOnBack(async () =>
          interaction.input({
            message: 'Choose a local value',
            backLabel: 'previous menu',
          }),
        ),
      [{ waitFor: 'Choose a local value', input: '\x1b' }],
    );
    const cancelled = await driveInk(
      async (interaction) => {
        try {
          await returnOnBack(async () =>
            interaction.input({
              message: 'Choose a value',
              backLabel: 'previous menu',
            }),
          );
        } catch (error) {
          return commandError(error);
        }

        throw new Error('Ctrl-C unexpectedly returned to the local menu');
      },
      [{ waitFor: 'Choose a value', input: '\x03' }],
    );

    expect(back.matchedSteps).toBe(1);
    expect(back.result).toBeUndefined();
    expect(cancelled.matchedSteps).toBe(1);
    expect(cancelled.result.code).toBe('CANCELLED');
    expect(
      resultExitCode({ command: 'show', ok: false, error: cancelled.result }),
    ).toBe(130);
  });

  it('should consume idle input without echo or replay into the next prompt', async () => {
    const observed = await driveInk(
      async (interaction) => {
        const first = await interaction.input({
          message: 'First safe value',
          defaultValue: 'a',
        });
        interaction.status({ kind: 'info', message: 'Prompt-free marker' });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const second = await interaction.input({
          message: 'Second safe value',
          defaultValue: 'b',
        });

        return { first, second };
      },
      [
        { waitFor: 'First safe value', input: '\r' },
        { waitFor: 'Prompt-free marker', input: 'x', waitForRender: false },
        { waitFor: 'Second safe value', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(3);
    expect(observed.result).toEqual({ first: 'a', second: 'b' });
    expect(observed.output).not.toContain('ax');
  });

  it('should settle queued prompts in order through the persistent Ink root', async () => {
    const observed = await driveInk(
      async (interaction) => {
        const first = interaction.input({
          message: 'Queued first value',
          defaultValue: 'one',
        });
        const second = interaction.input({
          message: 'Queued second value',
          defaultValue: 'two',
        });

        return Promise.all([first, second]);
      },
      [
        { waitFor: 'Queued first value', input: '\r' },
        { waitFor: 'Queued second value', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(2);
    expect(observed.result).toEqual(['one', 'two']);
  });

  it('should silence status and progress after cancellation and releases supplied streams', async () => {
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: (enabled: boolean) => {
        raw = enabled;

        return input;
      },
    });
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
      rows: 24,
    });
    let raw = false;
    let captured = '';
    output.on('data', (chunk: Buffer) => {
      captured += chunk.toString();
    });
    const inputListeners = input.listenerCount('readable');
    const controller = new AbortController();
    const session = createInteraction(
      true,
      { stdin: input, stderr: output },
      {
        signal: controller.signal,
        cancel: vi.fn(),
        interrupt: vi.fn(),
      },
    );
    try {
      session.status({ kind: 'info', message: 'Before cancellation' });
      controller.abort();
      const afterCancel = captured;
      session.status({ kind: 'info', message: 'After cancellation' });
      session.progress({ stage: 'after', message: 'After progress' });

      expect(captured).toBe(afterCancel);
      expect(afterCancel).toContain('Before cancellation');
    } finally {
      await session.dispose();
      await session.dispose();
    }

    expect(raw).toBe(false);
    expect(input.listenerCount('readable')).toBe(inputListeners);
    expect(input.destroyed).toBe(false);
    expect(output.destroyed).toBe(false);
    input.write('post-dispose-input');
    expect(input.read()).toBe('post-dispose-input');
    const beforeOutput = captured;
    output.write('post-dispose-output');
    expect(captured).toBe(`${beforeOutput}post-dispose-output`);
    input.destroy();
    output.destroy();
  });

  it('should print verbose stage lines on stderr while an Ink prompt stays open', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      lines.push(chunk);

      return true;
    }) as never);
    const reportStage = createStageReporter(
      { command: 'show', options: { verbose: true, quiet: true } },
      () => undefined,
    );
    const observed = await driveInk(
      async (interaction) => {
        reportStage({ stage: 'command', event: 'start', targetKnown: false });
        const answer = interaction.input({ message: 'Sprites API token' });
        reportStage({
          stage: 'command',
          event: 'complete',
          durationMs: 1,
          outcome: 'ok',
          targetKnown: false,
        });

        return answer;
      },
      [{ waitFor: 'Sprites API token', input: ['a', '\r'] }],
    );

    expect(observed.matchedSteps, observed.output).toBe(1);
    expect(observed.result).toBe('a');
    expect(lines).toEqual([
      '[verbose] stage=command event=start command=show targetKnown=false\n',
      '[verbose] stage=command event=complete durationMs=1 outcome=ok command=show targetKnown=false\n',
    ]);
    expect(observed.output).not.toContain('[verbose]');
  });
});

/**
 * turns a missing prompt settlement into an assertable result
 * @param promise prompt outcome to observe
 * @returns the result or a pending marker after one bounded render interval
 */
async function settleWithin<T>(
  promise: Promise<T>,
): Promise<T | 'still pending'> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'still pending'>((resolve) => {
        timeout = setTimeout(() => resolve('still pending'), 250);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
