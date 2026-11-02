import { describe, expect, it, vi } from 'vitest';

import { probeProgress } from '#application/inspection/progress';

import type { Interaction } from '#application/ports/interaction';

describe('fn:probeProgress', () => {
  it('should report a failed probe with elapsed seconds and no completion credit', () => {
    const progress = vi.fn<Interaction['progress']>();

    probeProgress(progress)!({
      probe: 'network',
      phase: 'failed',
      durationMs: 1250,
    });

    expect(progress.mock.calls).toEqual([
      [{ stage: 'network', message: 'Check failed (1.3 s)' }],
    ]);
  });
});
