import { describe, expect, it, vi } from 'vitest';

import { createCommandCancellation } from '../../src/cli/cancellation.js';

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
