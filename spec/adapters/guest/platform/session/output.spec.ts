import { describe, expect, it } from 'vitest';

import { StatusStream } from '#adapters/guest/platform/session/output';

describe('cl:StatusStream', () => {
  it('should await a split status and preserve later output for another command', () => {
    const stream = new StatusStream();
    stream.push(Buffer.from('first\nmarker:1'));
    expect(stream.take('marker:')).toBeUndefined();
    stream.push('2\nsecond\nnext:0\n');
    expect(stream.take('marker:')).toEqual({
      marker: 'marker:',
      output: 'first',
      status: 12,
    });
    expect(stream.take('marker:')).toEqual({
      marker: 'marker:',
      output: 'first',
      status: 12,
    });
    expect(stream.take('next:')).toEqual({
      marker: 'next:',
      output: 'second',
      status: 0,
    });
  });

  it('should retain the latest bounded output and mark that earlier bytes were dropped', () => {
    const stream = new StatusStream();
    stream.push('x'.repeat(4_194_304) + 'tail');
    expect(stream.take('marker:')).toBeUndefined();
    stream.push('\nmarker:0\n');
    const result = stream.take('marker:');

    expect(result?.output).toBe(
      '[earlier output truncated]\n' + 'x'.repeat(4_194_300) + 'tail',
    );
    stream.push('next\nnext:0\n');
    expect(stream.take('next:')?.output).toBe('next');
  });

  it.each(['', '1234', '/'])(
    'should refuse a malformed completed status (%j)',
    (status) => {
      const stream = new StatusStream();
      stream.push(`\nmarker:${status}\n`);
      expect(() => stream.take('marker:')).toThrow(/status line/u);
    },
  );
});
