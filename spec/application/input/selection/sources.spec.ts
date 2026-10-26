import { describe, expect, it, vi } from 'vitest';

import {
  activePrompts,
  environmentReader,
} from '#application/input/selection/sources';

import type { InputSources } from '#application/input/sources';
import type { Interaction } from '#application/ports/interaction';

describe('fn:environmentReader', () => {
  it('should trim comma-separated values and parse a false boolean from the selected file', () => {
    const sources = {
      processEnv: {
        OPEN_AGENT_HARNESSES: 'claude',
        CLIPROXYAPI_ENABLED: 'true',
      },
      fileEnv: {
        OPEN_AGENT_HARNESSES: ' codex, , claude ',
        CLIPROXYAPI_ENABLED: 'off',
      },
      profile: {},
    } satisfies InputSources;
    const read = environmentReader(sources);

    expect({
      harnesses: read.list('OPEN_AGENT_HARNESSES'),
      proxy: read.flag(undefined, 'CLIPROXYAPI_ENABLED'),
    }).toEqual({
      harnesses: ['codex', 'claude'],
      proxy: { value: false, problems: [] },
    });
  });
});

describe('fn:activePrompts', () => {
  it('should skip a single-choice prompt and validate a whole-number answer', async () => {
    const validation: Array<string | undefined> = [];
    const interaction = {
      input: vi.fn<Interaction['input']>(async (prompt) => {
        validation.push(
          prompt.validate?.('1.5'),
          prompt.validate?.('2'),
          prompt.validate?.('4'),
        );

        return '4';
      }),
      secret: async () => '',
      select: async <V extends string>(): Promise<V> => {
        throw new Error('Unexpected selection prompt');
      },
      multiselect: async <V extends string>(): Promise<V[]> => {
        throw new Error('Unexpected multiple-choice prompt');
      },
      confirm: async () => false,
      progress: () => undefined,
      status: () => undefined,
    } satisfies Interaction;
    const prompts = activePrompts({
      options: {},
      sources: { processEnv: {}, fileEnv: {}, profile: {} },
      interaction,
    });

    expect(
      await prompts?.chooseMany('Harnesses', [
        { label: 'Claude', value: 'claude' },
      ]),
    ).toBeUndefined();
    expect(
      await prompts?.number('Minimum CPUs', 1, {
        unit: 'CPUs',
        minimum: 1,
        check: (value) =>
          value < 4 ? 'No machine is large enough' : undefined,
      }),
    ).toBe(4);
    expect(validation).toEqual([
      expect.stringContaining('whole number'),
      'No machine is large enough',
      undefined,
    ]);
  });
});
