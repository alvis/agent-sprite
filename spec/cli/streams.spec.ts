import { stdout } from 'node:process';

import { describe, expect, it, vi } from 'vitest';

import { flushOutput } from '#cli/streams';

describe('fn:flushOutput', () => {
  it('should reject when a final stream flush reports an error', async () => {
    const failure = new Error('Output stream closed');
    using _writing = vi.spyOn(stdout, 'write').mockImplementation((...args) => {
      const callback = args.find(
        (argument): argument is (error?: Error | null) => void =>
          typeof argument === 'function',
      );
      callback?.(failure);

      return true;
    });

    await expect(flushOutput()).rejects.toEqual(failure);
  });
});
