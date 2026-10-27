import { PassThrough } from 'node:stream';

import { render } from 'ink';
import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { TextInput } from '#cli/components/TextInput';
import { createInteraction } from '#cli/interaction';

import type { ComponentProps, ReactNode } from 'react';

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();

  return {
    ...actual,
    render: vi.fn(actual.render),
  } satisfies Partial<typeof import('ink')>;
});

describe('fn:createInteraction renderer races', () => {
  it('should ignore late submit and cancellation events from a retired prompt while the next prompt remains usable', async () => {
    const prompts: Array<ComponentProps<typeof TextInput>> = [];
    const realRender = vi.mocked(render).getMockImplementation();
    if (!realRender) {
      throw new Error('Real renderer missing from boundary mock');
    }
    vi.mocked(render).mockImplementation((...args) => {
      const instance = realRender(...args);
      const realRerender = instance.rerender;

      return {
        ...instance,
        rerender: (element) => {
          if (isValidElement<{ prompt?: ReactNode }>(element)) {
            const prompt = element.props.prompt;
            if (
              isValidElement<ComponentProps<typeof TextInput>>(prompt) &&
              prompt.type === TextInput
            ) {
              prompts.push(prompt.props);
            }
          }
          realRerender(element);
        },
      };
    });
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
      const first = session.input({ message: 'Retiring prompt' });
      const second = session.input({ message: 'Current prompt' });
      const retired = prompts.find(({ label }) => label === 'Retiring prompt');
      if (!retired) {
        throw new Error('Retiring prompt was not rendered');
      }
      retired.onSubmit('first answer');
      const firstAnswer = await first;
      const current = prompts.find(({ label }) => label === 'Current prompt');
      if (!current) {
        throw new Error('Current prompt was not rendered');
      }

      retired.onSubmit('late answer');
      retired.onCancel();
      current.onSubmit('second answer');

      expect({ first: firstAnswer, second: await second }).toEqual({
        first: 'first answer',
        second: 'second answer',
      });
    } finally {
      await session.dispose();
      input.destroy();
      output.destroy();
    }
  });
});
