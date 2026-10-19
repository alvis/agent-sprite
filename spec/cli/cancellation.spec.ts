import { describe, expect, it, vi } from 'vitest';

import { createCommandCancellation } from '#cli/cancellation';

describe('fn:createCommandCancellation listener ownership', () => {
  it('should release both process signal listeners when the command ends', () => {
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');
    const cancellation = createCommandCancellation({ onForce: vi.fn() });

    try {
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore + 1);
    } finally {
      cancellation.dispose();
    }

    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });
});

describe('fn:createCommandCancellation interruption', () => {
  it('should cancel on the first interrupt and force exit within the flush bound on the second', async () => {
    vi.useFakeTimers();
    const exitCode = process.exitCode;
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const onForce = vi.fn();
    const cancellation = createCommandCancellation({ onForce });

    try {
      cancellation.interrupt();

      expect(cancellation.signal.aborted).toBe(true);
      expect(process.exitCode).toBe(130);
      expect(onForce).not.toHaveBeenCalled();

      cancellation.interrupt();
      vi.advanceTimersByTime(100);

      expect(onForce).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(130);
      // the flush settles and exits too, so nothing outlives the spy
      await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(2));
    } finally {
      cancellation.dispose();
      process.exitCode = exitCode;
      vi.useRealTimers();
      exit.mockRestore();
    }
  });
});
