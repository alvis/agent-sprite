import { Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it } from 'vitest';

import { assertManaged } from '#adapters/drivers/providers/sprite/records';

const unowned = new Sprite('unowned', new SpritesClient('offline-test'));

describe('fn:assertManaged', () => {
  it('should refuse mutation of an unowned provider observation', () => {
    expect(() => assertManaged(unowned)).toThrow(
      expect.objectContaining({ code: 'ownership-mismatch' }),
    );
  });
});
