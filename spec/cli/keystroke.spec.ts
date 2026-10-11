import { describe, expect, it } from 'vitest';

import { isPrintableInput } from '#cli/keystroke';

describe('fn:isPrintableInput', () => {
  it('should accept pasted Unicode text and reject embedded terminal control bytes', () => {
    const accepted = ['', 'printable text', 'café 😀 漢字'].map(
      isPrintableInput,
    );
    const rejected = [
      '\u001b[31msecret',
      'line\nfeed',
      '\u007f',
      'nul\u0000byte',
    ].map(isPrintableInput);

    expect({ accepted, rejected }).toEqual({
      accepted: [true, true, true],
      rejected: [false, false, false, false],
    });
  });
});
