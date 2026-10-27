import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { prepareResult } from '#cli/output';
import { rememberSecret } from '#kernel/redaction';

import type { CommandResult } from '#application/result';

const RESULT: CommandResult = {
  command: 'list',
  ok: true,
  data: {
    machines: [
      {
        name: 'primary',
        id: 'sprite-primary',
        organization: 'example',
        provider: 'sprite',
        state: 'running',
        setup: 'ready',
        readiness: 'not inspected',
        newerRelease: '9.9.9',
      },
    ],
    unavailable: [
      { provider: 'fly-machine', code: 'PROVIDER', reason: 'upstream-timeout' },
    ],
  },
};

describe('fn:prepareResult', () => {
  it('should preserve safe output as registered credentials shadow list field and collection keys', () => {
    const streams = { stdout: new PassThrough(), stderr: new PassThrough() };
    try {
      rememberSecret('provider');
      rememberSecret('reason');
      rememberSecret('name');
      const fields = prepareResult({ result: RESULT, options: {}, streams });

      rememberSecret('unavailable');
      const unavailable = prepareResult({
        result: RESULT,
        options: {},
        streams,
      });

      rememberSecret('machines');
      const machines = prepareResult({ result: RESULT, options: {}, streams });

      expect([fields, unavailable, machines]).toEqual([
        {
          channel: 'stdout',
          text: '\tsprite-primary\trunning\t\t\tready\texample\t\n',
          notes: expect.stringMatching(
            /^(?!.*undefined)[^\n]+\n(?!.*undefined)[^\n]*9\.9\.9[^\n]*\n$/u,
          ),
        },
        {
          channel: 'stdout',
          text: '\tsprite-primary\trunning\t\t\tready\texample\t\n',
          notes: expect.stringMatching(
            /^(?!.*undefined)[^\n]*9\.9\.9[^\n]*\n$/u,
          ),
        },
        {
          channel: 'stdout',
          text: expect.stringContaining('upstream-timeout'),
          notes: undefined,
        },
      ]);
    } finally {
      streams.stdout.destroy();
      streams.stderr.destroy();
    }
  });
});
