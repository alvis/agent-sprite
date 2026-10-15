import { describe, expect, it } from 'vitest';

import { isKeepAwakeMode, isOwnAwakeModule } from '#guest/idle/provider-facts';

describe('fn:isOwnAwakeModule', () => {
  it.each([
    [
      'an -awake module of its own guest folder',
      'drivers/providers/sprite/guest/sprite-awake.js',
      true,
    ],
    [
      'a module of another provider folder',
      'drivers/providers/other/guest/sprite-awake.js',
      false,
    ],
    [
      'a module without the -awake suffix',
      'drivers/providers/sprite/guest/sprite-hold.js',
      false,
    ],
    [
      'a module nested below the guest folder',
      'drivers/providers/sprite/guest/x/sprite-awake.js',
      false,
    ],
    [
      'a module nested below a folder named like the guest folder',
      'drivers/providers/sprite/guest/sprite/guest/sprite-awake.js',
      false,
    ],
    [
      'a module with a parent segment',
      'drivers/providers/sprite/guest/../guest/sprite-awake.js',
      false,
    ],
    [
      'an absolute path',
      '/drivers/providers/sprite/guest/sprite-awake.js',
      false,
    ],
    [
      'a path with a prefix',
      'lib/drivers/providers/sprite/guest/sprite-awake.js',
      false,
    ],
  ])('should tell whether %s is an awake adapter', (_, module, expected) => {
    expect(isOwnAwakeModule(module, 'sprite')).toBe(expected);
  });
});

describe('fn:isKeepAwakeMode', () => {
  it.each([
    ['native-deadline', true],
    ['governed', true],
    ['none', true],
    ['sleepy', false],
    ['toString', false],
    [1, false],
  ])('should tell whether %s is a keep-awake mode', (value, expected) => {
    expect(isKeepAwakeMode(value)).toBe(expected);
  });
});
