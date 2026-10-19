import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

import {
  inBandCommand,
  InBandStatusFilter,
  splitInBandStatus,
  verifiedStatus,
} from '#adapters/drivers/providers/fly-machine/in-band';
import { ProviderFault } from '#kernel/provider-fault';

const MARKER = '@@open-agent-status:test:';

/**
 * runs an in-band command line the way the guest splits and runs it
 * @param words program followed by its arguments
 * @returns exit status, standard output, and standard error split from the reported status
 */
async function runLine(words: readonly string[]): Promise<{
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  status: number | undefined;
}> {
  const { line, marker } = inBandCommand(words);
  const result = await execa('/bin/sh', ['-c', line], {
    reject: false,
    encoding: 'buffer',
  });
  const split = splitInBandStatus(Buffer.from(result.stderr), marker);

  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString(),
    stderr: split.stderr.toString(),
    status: split.status,
  };
}

/**
 * captures what a call throws
 * @param call call expected to throw
 * @returns the thrown value, or undefined when the call returned
 */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }

  return undefined;
}

describe('fn:inBandCommand', () => {
  it('should pass every word unchanged and report the exit status after the command own standard error', async () => {
    const words = [
      '/bin/sh',
      '-c',
      'printf "%s|" "$@"; echo own >&2; exit 42',
      'script',
      "it's",
      '$HOME `id` ; |',
    ];

    const result = await runLine(words);

    expect(result).toEqual({
      exitCode: 42,
      stdout: "it's|$HOME `id` ; ||",
      stderr: 'own\n',
      status: 42,
    });
  });
});

describe('cl:InBandStatusFilter', () => {
  describe('mt:push', () => {
    it('should stream standard error while holding back only a possible marker prefix', () => {
      const filter = new InBandStatusFilter(MARKER);
      const stream = Buffer.from(
        `warning: @@ not a marker\n${MARKER}7\nError: ssh exited 1\n`,
      );
      const chunks = [3, 17, 26, 30, 31, stream.length].map(
        (end, index, ends) => stream.subarray(ends[index - 1] ?? 0, end),
      );

      const passed = Buffer.concat([
        ...chunks.map((chunk) => filter.push(chunk)),
        filter.end(),
      ]);

      expect({ passed: passed.toString(), status: filter.status }).toEqual({
        passed: 'warning: @@ not a marker\n',
        status: 7,
      });
    });

    it('should report no status when the transport ended before the status line', () => {
      const filter = new InBandStatusFilter(MARKER);

      const passed = Buffer.concat([
        filter.push(Buffer.from('connection lost\n@@open-agent')),
        filter.end(),
      ]);

      expect({ passed: passed.toString(), status: filter.status }).toEqual({
        passed: 'connection lost\n@@open-agent',
        status: undefined,
      });
    });

    it('should hold a marker line arriving in pieces until its status completes', () => {
      const filter = new InBandStatusFilter(MARKER);

      const passed = Buffer.concat([
        filter.push(Buffer.from(`own\n${MARKER}`)),
        filter.push(Buffer.from('4')),
        filter.push(Buffer.from('2\n')),
        filter.end(),
      ]);

      expect({ passed: passed.toString(), status: filter.status }).toEqual({
        passed: 'own',
        status: 42,
      });
    });
  });
});

describe('fn:splitInBandStatus', () => {
  it.each([
    [
      'a spoofed marker line the real one follows',
      `${MARKER}0\nown\n${MARKER}3\nError: ssh exited 1\n`,
      { stderr: 'own', status: 3 },
    ],
    [
      'two marker lines, keeping the text between them',
      `first\n${MARKER}9\nbetween\n${MARKER}0\n`,
      { stderr: 'firstbetween', status: 0 },
    ],
    [
      'text that follows the last marker line on the same stream',
      `own\n${MARKER}5\ntransport report\n`,
      { stderr: 'own', status: 5 },
    ],
    [
      'a status above 255',
      `own\n${MARKER}256\n`,
      { stderr: 'own', status: undefined },
    ],
    [
      'a status of four digits',
      `own\n${MARKER}1000\n`,
      { stderr: 'own', status: undefined },
    ],
    [
      'a marker line without digits',
      `own\n${MARKER}\n`,
      { stderr: 'own', status: undefined },
    ],
    [
      'a final marker line without its newline',
      `own\n${MARKER}255`,
      { stderr: 'own', status: 255 },
    ],
  ])('should split %s', (_, stderr, expected) => {
    const split = splitInBandStatus(Buffer.from(stderr), MARKER);

    expect({ stderr: split.stderr.toString(), status: split.status }).toEqual(
      expected,
    );
  });
});

describe('fn:verifiedStatus', () => {
  it.each([
    { outcome: 'a success both report', status: 0, transportExit: 0 },
    { outcome: 'a failure both report', status: 3, transportExit: 1 },
  ])('should accept $outcome', ({ status, transportExit }) => {
    expect(verifiedStatus(status, transportExit, '')).toBe(status);
  });

  it.each([
    {
      outcome: 'a missing status after flyctl succeeded',
      status: undefined,
      transportExit: 0,
      message:
        'The SSH session ended before the guest reported a status (flyctl exited 0): lost',
    },
    {
      outcome: 'a missing status after flyctl failed',
      status: undefined,
      transportExit: 1,
      message:
        'The SSH session ended before the guest reported a status (flyctl exited 1): lost',
    },
    {
      outcome: 'a success flyctl contradicts',
      status: 0,
      transportExit: 1,
      message: 'The SSH session reported status 0 while flyctl exited 1: lost',
    },
    {
      outcome: 'a failure flyctl contradicts',
      status: 2,
      transportExit: 0,
      message: 'The SSH session reported status 2 while flyctl exited 0: lost',
    },
    {
      outcome: 'a session a signal ended',
      status: 0,
      transportExit: null,
      message:
        'The SSH session reported status 0 while flyctl exited by signal: lost',
    },
  ])(
    'should refuse $outcome as transient',
    ({ status, transportExit, message }) => {
      expect(
        thrownBy(() => verifiedStatus(status, transportExit, ' lost\n')),
      ).toEqual(new ProviderFault({ code: 'transient', message }));
    },
  );
});
