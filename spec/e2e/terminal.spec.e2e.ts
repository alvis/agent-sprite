import { execPath } from 'node:process';

import { describe, expect, it } from 'vitest';

import { runTerminal } from '../fixtures/terminal.js';

describe('fixture:native terminal', () => {
  it('should wait for each visible prompt before sending input', async () => {
    const program = `
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdout.write('First prompt: ');
      process.stdin.once('data', first => {
        process.stdout.write('Second prompt: ');
        process.stdin.once('data', second => {
          process.stdout.write(JSON.stringify({ first: first.toString(), second: second.toString() }));
          process.exit(0);
        });
      });
    `;
    const result = await runTerminal(
      execPath,
      [
        { waitFor: 'First prompt:', input: 'a' },
        { waitFor: 'Second prompt:', input: 'b' },
      ],
      { args: ['--eval', program] },
    );

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.matchedSteps).toBe(2);
    expect(result.output).toContain('{"first":"a","second":"b"}');
  });

  it('should stop early when the next prompt does not appear within the step timeout', async () => {
    const program = `
      process.stdout.write('First prompt: ');
      process.stdin.once('data', () => setInterval(() => {}, 1000));
    `;
    const result = await runTerminal(
      execPath,
      [
        { waitFor: 'First prompt:', input: 'a' },
        { waitFor: 'Second prompt:', input: 'b' },
      ],
      { args: ['--eval', program], stepTimeout: 500, timeout: 15_000 },
    );

    expect({
      timedOut: result.timedOut,
      matchedSteps: result.matchedSteps,
      early: result.elapsedMs < 5_000,
    }).toEqual({ timedOut: true, matchedSteps: 1, early: true });
  });
});
