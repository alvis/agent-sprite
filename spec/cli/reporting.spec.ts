import { stderr } from 'node:process';

import { describe, expect, it, vi } from 'vitest';

import { createStageReporter, createStatusReporter } from '#cli/reporting';

import type { InteractionSession } from '#cli/interaction';
import type { StageEvent } from '#kernel/operation';
import type { StatusUpdate } from '#kernel/status';

const failedStage = {
  event: 'complete',
  stage: 'setup.tools',
  outcome: 'failed',
  durationMs: 12,
  targetKnown: true,
} satisfies StageEvent;
const statuses = [
  { kind: 'info', message: 'Reading inventory' },
  { kind: 'success', message: 'Inventory read' },
  { kind: 'warning', message: 'Provider unavailable' },
  { kind: 'error', message: 'Inventory failed' },
] satisfies StatusUpdate[];

describe('fn:createStageReporter', () => {
  it.each([
    {
      name: 'interactive progress',
      interactive: true,
      progressCalls: [
        [
          {
            stage: 'setup.tools',
            message: expect.stringContaining('Failed'),
            phase: 'complete',
            outcome: 'failed',
            durationMs: 12,
          },
        ],
      ],
      writes: [],
    },
    {
      name: 'noninteractive stderr',
      interactive: false,
      progressCalls: [],
      writes: [[expect.stringMatching(/setup\.tools.*failed.*12 ms/u)]],
    },
  ])(
    'should report a failed stage through $name',
    ({ interactive, progressCalls, writes }) => {
      const progress = vi.fn<InteractionSession['progress']>();
      const session = {
        progress,
      } satisfies Partial<InteractionSession> as Partial<InteractionSession> as InteractionSession;
      using writing = vi.spyOn(stderr, 'write').mockImplementation(() => true);
      const report = createStageReporter(
        { command: 'setup', options: {} },
        () => (interactive ? session : undefined),
      );

      report(failedStage);

      expect(progress.mock.calls).toEqual(progressCalls);
      expect(writing.mock.calls).toEqual(writes);
    },
  );
});

describe('fn:createStatusReporter', () => {
  it.each([
    {
      name: 'quiet interactive status',
      quiet: true,
      statusCalls: [[statuses[2]], [statuses[3]]],
      writes: [],
    },
    {
      name: 'verbose noninteractive stderr',
      quiet: false,
      statusCalls: [],
      writes: [
        [expect.stringMatching(/Info:.*Reading inventory/u)],
        [expect.stringMatching(/Info:.*Inventory read/u)],
        [expect.stringMatching(/Warning:.*Provider unavailable/u)],
        [expect.stringMatching(/Error:.*Inventory failed/u)],
      ],
    },
  ])(
    'should route $name with its configured verbosity',
    ({ quiet, statusCalls, writes }) => {
      const status = vi.fn<InteractionSession['status']>();
      const session = {
        status,
      } satisfies Partial<InteractionSession> as Partial<InteractionSession> as InteractionSession;
      using writing = vi.spyOn(stderr, 'write').mockImplementation(() => true);
      const report = createStatusReporter(
        { command: 'show', options: { quiet } },
        () => (quiet ? session : undefined),
      );

      for (const update of statuses) {
        report(update);
      }

      expect(status.mock.calls).toEqual(statusCalls);
      expect(writing.mock.calls).toEqual(writes);
    },
  );
});
