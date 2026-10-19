import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { commandError } from '#application/failures';
import { resolveSecret } from '#application/input/sources';
import { withBackNavigation } from '#application/navigation';
import { resultExitCode } from '#cli/exit';

import { createInteraction } from '#cli/interaction';
import { createStageReporter } from '#cli/reporting';

import { returnOnBack } from '#kernel/navigation';

import { driveInk } from '../fixtures/ink';
import { dependencies } from '../mocks/dependencies';

describe('fn:createInteraction', () => {
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
