import { describe, expect, it } from 'vitest';

import { commandError } from '#application/failures';
import { InteractionExit, returnOnBack } from '#kernel/navigation';

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

describe('cl:InteractionExit', () => {
  it('should report a cancellation as a user cancellation', () => {
    expect(commandError(new InteractionExit('cancel'))).toMatchObject({
      code: 'CANCELLED',
      message: 'Cancelled by user.',
    });
  });

  it('should not describe back navigation as a cancellation', () => {
    expect(new InteractionExit('back').message).not.toContain('Cancelled');
  });
});
