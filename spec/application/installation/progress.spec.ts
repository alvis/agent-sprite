import { describe, expect, it, vi } from 'vitest';

import { reportProgress } from '#application/installation/progress';
import { OperationContext, withOperation } from '#kernel/operation';

import type { Interaction } from '#application/ports/interaction';
import type { PlanProgress, SetupStep } from '#application/ports/plan';
import type { StatusUpdate } from '#kernel/status';

const STEP: SetupStep = {
  id: 'jj',
  component: 'tools',
  account: 'root',
  needs: [],
  apply: { argv: ['true'] },
  timeoutMs: 1000,
  critical: true,
  retry: 'transport',
};

const FINISHED: PlanProgress = {
  kind: 'step-finished',
  outcome: { step: STEP, status: 'applied', attempts: 1 },
  durationMs: 1234,
};

describe('fn:reportProgress', () => {
  it('should give the interaction how long a finished step took', () => {
    const progress = vi.fn<Interaction['progress']>();

    reportProgress(FINISHED, {
      input: async () => '',
      secret: async () => '',
      select: async (_prompt, choices) => choices[0]!.value,
      multiselect: async () => [],
      confirm: async () => true,
      progress,
      status: () => undefined,
    });

    expect(progress.mock.calls).toEqual([
      [
        {
          stage: 'tools',
          message: 'jj: applied',
          phase: 'complete',
          outcome: 'ok',
          durationMs: 1234,
        },
      ],
    ]);
  });

  it('should stream a finished step with its duration as a status line without an interaction', async () => {
    const reported = vi.fn<(update: StatusUpdate) => void>();
    const context = new OperationContext({
      signal: new AbortController().signal,
      onStatus: reported,
    });

    await withOperation(context, async () => {
      reportProgress(FINISHED);
      reportProgress({ kind: 'step-started', step: STEP, attempt: 1 });
    });

    expect(reported.mock.calls).toEqual([
      [{ kind: 'info', message: 'jj: applied (1234 ms)' }],
      [{ kind: 'info', message: 'Setting up jj' }],
    ]);
  });
});
