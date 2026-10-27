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

  it.each([
    { scenario: 'empty', script: 'exit 7', stderr: '' },
    {
      scenario: 'without a final newline',
      script: 'printf warning >&2; exit 7',
      stderr: 'warning',
    },
    {
      scenario: 'with a final newline',
      script: "printf 'warning\\n' >&2; exit 7",
      stderr: 'warning\n',
    },
  ])('should preserve $scenario guest stderr', async ({ script, stderr }) => {
    const result = await runLine(['/bin/sh', '-c', script]);

    expect(result).toEqual({ exitCode: 7, stdout: '', stderr, status: 7 });
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
        passed: 'own\n',
        status: 42,
      });
    });

    it.each([
      { scenario: 'empty guest stderr', guest: '' },
      { scenario: 'guest stderr without a final newline', guest: 'warning' },
      { scenario: 'guest stderr with a final newline', guest: 'warning\n' },
    ])('should preserve $scenario at every frame split', ({ guest }) => {
      const bytes = Buffer.from(`${guest}${MARKER}7\n`);

      for (let boundary = 0; boundary <= bytes.length; boundary++) {
        const filter = new InBandStatusFilter(MARKER);
        const passed = Buffer.concat([
          filter.push(bytes.subarray(0, boundary)),
          filter.push(bytes.subarray(boundary)),
          filter.end(),
        ]);

        expect({ stderr: passed.toString(), status: filter.status }).toEqual({
          stderr: guest,
          status: 7,
        });
      }
    });

    it('should release a guest newline before the marker arrives', () => {
      const filter = new InBandStatusFilter(MARKER);

      const first = filter.push(Buffer.from('warning\n'));
      const frame = Buffer.concat([
        filter.push(Buffer.from(`${MARKER}7\n`)),
        filter.end(),
      ]);

      expect({
        first: first.toString(),
        frame: frame.toString(),
        status: filter.status,
      }).toEqual({ first: 'warning\n', frame: '', status: 7 });
    });

    it('should release guest stderr beyond the transport trailer bound', () => {
      const guest = 'x'.repeat(65_537);
      const filter = new InBandStatusFilter(MARKER);

      const first = filter.push(Buffer.from(`${MARKER}0\n`));
      const overflow = filter.push(Buffer.from(guest));
      const final = Buffer.concat([
        filter.push(Buffer.from(`${MARKER}3\n`)),
        filter.end(),
      ]);

      expect({
        first: first.toString(),
        overflow: overflow.toString(),
        final: final.toString(),
        status: filter.status,
      }).toEqual({ first: '', overflow: guest, final: '', status: 3 });
    });
  });
});

describe('fn:splitInBandStatus', () => {
  it.each([
    {
      scenario: 'a spoofed marker line the real one follows',
      stderr: `${MARKER}0\nown\n${MARKER}3\nError: ssh exited 1\n`,
      expected: { stderr: 'own\n', status: 3 },
    },
    {
      scenario: 'two marker lines, keeping the text between them',
      stderr: `first\n${MARKER}9\nbetween\n${MARKER}0\n`,
      expected: { stderr: 'first\nbetween\n', status: 0 },
    },
    {
      scenario: 'text that follows the last marker line on the same stream',
      stderr: `own\n${MARKER}5\ntransport report\n`,
      expected: { stderr: 'own\n', status: 5 },
    },
    {
      scenario: 'a status above 255',
      stderr: `own\n${MARKER}256\n`,
      expected: { stderr: 'own\n', status: undefined },
    },
    {
      scenario: 'a status of four digits',
      stderr: `own\n${MARKER}1000\n`,
      expected: { stderr: 'own\n', status: undefined },
    },
    {
      scenario: 'a marker line without digits',
      stderr: `own\n${MARKER}\n`,
      expected: { stderr: 'own\n', status: undefined },
    },
    {
      scenario: 'a marker line with a non-digit status',
      stderr: `own\n${MARKER}x\n`,
      expected: { stderr: 'own\n', status: undefined },
    },
    {
      scenario: 'a final marker line without its newline',
      stderr: `own\n${MARKER}255`,
      expected: { stderr: 'own\n', status: 255 },
    },
  ])('should split $scenario', ({ stderr, expected }) => {
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
  it('should report a missing status without inventing a transport diagnostic', () => {
    const failure = thrownBy(() => verifiedStatus(undefined, undefined, ''));

    expect(failure).toMatchObject({
      code: 'transient',
      message: expect.not.stringContaining(':'),
    });
  });
});
