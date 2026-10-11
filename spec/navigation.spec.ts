import { describe, expect, it } from 'vitest';

import { InteractionExit, returnOnBack } from '#navigation';

describe('fn:returnOnBack', () => {
  it('should turn back navigation into an absent result', async () => {
    const result = await returnOnBack(async () => {
      throw new InteractionExit('back');
    });

    expect(result).toBeUndefined();
  });

  it('should preserve cancellation as a distinct exit', async () => {
    await expect(
      returnOnBack(async () => {
        throw new InteractionExit('cancel');
      }),
    ).rejects.toMatchObject({ action: 'cancel' });
  });
});
