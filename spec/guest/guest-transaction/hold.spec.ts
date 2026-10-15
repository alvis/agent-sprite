import { describe, expect, it, vi } from 'vitest';

import { holdForTransaction } from '#guest/guest-transaction/hold';
import { withAwakeHold } from '#guest/idle/hold';

import type { AwakeHolder } from '#guest/idle/hold';

vi.mock('#guest/idle/hold', () => ({ withAwakeHold: vi.fn() }));

/** what a fake awake hold did, in order */
const trail: string[] = [];

/**
 * stands in for the governor's hold, recording when it opens and closes
 * @param holder the holder the transaction opened
 * @param operation the work the hold protects
 * @returns the operation's result, after the close was recorded
 */
async function recordingHold(
  holder: AwakeHolder,
  operation: () => Promise<unknown>,
): Promise<unknown> {
  trail.push(`open ${holder.source}`);
  try {
    return await operation();
  } finally {
    trail.push(`close ${holder.source}`);
  }
}

describe('fn:holdForTransaction', () => {
  it('should hold open until the transaction ends and close the hold before it settles', async () => {
    trail.length = 0;
    vi.mocked(withAwakeHold).mockImplementation(recordingHold);

    const end = await holdForTransaction();

    expect(trail).toEqual(['open transaction']);
    await end();
    expect(trail).toEqual(['open transaction', 'close transaction']);
  });

  it('should hold as the transaction source with a session the awake command accepts', async () => {
    vi.mocked(withAwakeHold).mockImplementation(recordingHold);

    await (
      await holdForTransaction()
    )();

    expect(vi.mocked(withAwakeHold).mock.calls.at(-1)?.[0]).toEqual({
      source: 'transaction',
      session: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
  });

  it('should close the hold even when it is ended before the hold has opened', async () => {
    trail.length = 0;
    let isOpening = true;
    vi.mocked(withAwakeHold).mockImplementation(async (holder, operation) => {
      // the open itself is slow, so the transaction can end first
      await new Promise((resolve) => setTimeout(resolve, 10));
      isOpening = false;

      return recordingHold(holder, operation);
    });

    const end = await holdForTransaction();
    await end();

    expect(isOpening).toBe(false);
    expect(trail).toEqual(['open transaction', 'close transaction']);
  });

  it('should end twice without opening or closing the hold twice', async () => {
    trail.length = 0;
    vi.mocked(withAwakeHold).mockImplementation(recordingHold);

    const end = await holdForTransaction();
    await end();
    await end();

    expect(trail).toEqual(['open transaction', 'close transaction']);
  });

  it('should not return before the hold has opened', async () => {
    trail.length = 0;
    vi.mocked(withAwakeHold).mockImplementation(async (holder, operation) => {
      await new Promise((resolve) => setTimeout(resolve, 30));

      return recordingHold(holder, operation);
    });

    const end = await holdForTransaction();

    expect(trail).toEqual(['open transaction']);
    await end();
  });

  it('should return within the time bound when the hold never opens, then close the hold that opens late', async () => {
    trail.length = 0;
    let openLate = (): void => undefined;
    vi.mocked(withAwakeHold).mockImplementation(async (holder, operation) => {
      await new Promise<void>((resolve) => {
        openLate = resolve;
      });

      return recordingHold(holder, operation);
    });
    const startedAt = performance.now();

    const end = await holdForTransaction(50);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(trail).toEqual([]);
    openLate();
    await end();
    expect(trail).toEqual(['open transaction', 'close transaction']);
  });

  it('should return and close without failing when the hold cannot be opened', async () => {
    vi.mocked(withAwakeHold).mockRejectedValue(new Error('no governor'));

    const end = await holdForTransaction();

    await expect(end()).resolves.toBeUndefined();
  });
});
