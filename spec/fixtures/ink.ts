import { PassThrough } from 'node:stream';

import { createInteraction } from '#cli/interaction';

import type { Interaction } from '#application/ports/interaction';

export interface InkStep {
  waitFor: string;
  input: string | readonly string[];
  waitForRender?: boolean;
}

/**
 * drives the production Ink adapter through isolated streams and real key input
 * @param operation workflow called with the production interaction adapter
 * @param steps prompt and input sequence to drive
 */
export async function driveInk<T>(
  operation: (interaction: Interaction) => Promise<T>,
  steps: InkStep[],
): Promise<{ result: T; output: string; matchedSteps: number }> {
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
  let matchedSteps = 0;
  let searchFrom = 0;
  output.on('data', (chunk: Buffer) => {
    captured += chunk.toString();
    while (matchedSteps < steps.length) {
      const step = steps[matchedSteps];
      if (!step) {
        break;
      }
      const position = captured.indexOf(step.waitFor, searchFrom);
      if (position < 0) {
        break;
      }
      const ready =
        step.waitForRender === false
          ? position + step.waitFor.length
          : captured.indexOf('\x1b[?2026l', position + step.waitFor.length);
      if (ready < 0) {
        break;
      }
      searchFrom =
        ready + (step.waitForRender === false ? 0 : '\x1b[?2026l'.length);
      matchedSteps++;
      const chunks = typeof step.input === 'string' ? [step.input] : step.input;
      const writeChunk = (index: number): void => {
        const next = chunks[index];
        if (next !== undefined) {
          input.write(next, () => writeChunk(index + 1));
        }
      };
      writeChunk(0);
    }
  });
  const interaction = createInteraction({
    noColor: true,
    io: { stdin: input, stderr: output },
  });
  try {
    const result = await operation(interaction);

    return { result, output: captured, matchedSteps };
  } finally {
    await interaction.dispose();
    input.destroy();
    output.destroy();
  }
}
