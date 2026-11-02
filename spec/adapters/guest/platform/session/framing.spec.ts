import { describe, expect, it } from 'vitest';

import {
  commandScript,
  openBody,
} from '#adapters/guest/platform/session/framing';
import { Secret } from '#kernel/secret';

import type { SessionCommand, StepInput } from '#application/ports/session';

const command = {
  argv: ['/bin/cat'],
  timeoutMs: 1_000,
} satisfies SessionCommand;
const frame = {
  marker: 'test-marker:',
  shell: '/bin/sh',
  runAs: ['runuser', '-u', 'agent', '--'],
};
const text = "data ' that\nremains input ".repeat(8);
const bytes = Uint8Array.from([0, 255, 10, 0]);
const inputs = [
  {
    input: { kind: 'text', value: text },
    expected: Buffer.from(text),
    receiver: 'base64 -d |',
  },
  {
    input: { kind: 'bytes', value: bytes },
    expected: Buffer.from(bytes),
    receiver: 'base64 -d |',
  },
  {
    input: { kind: 'secret', value: Secret.embedding(text), as: 'stdin' },
    expected: Buffer.from(text),
    receiver: 'base64 -d |',
  },
  {
    input: { kind: 'secret', value: Secret.embedding(text), as: 'shm-file' },
    expected: Buffer.from(text),
    receiver: 'OPEN_AGENT_SECRET_FILE=',
  },
] satisfies Array<{ input: StepInput; expected: Buffer; receiver: string }>;

describe('fn:commandScript', () => {
  it.each(inputs)(
    'should carry $input.kind input as encoded data ($input.as)',
    ({ input, expected, receiver }) => {
      const script = commandScript({
        ...frame,
        command: {
          ...command,
          input,
          environment: { APP_MODE: "two ' words" },
        },
      });
      const [, encoded] =
        /<<'OPEN_AGENT_\w+' &\n([\s\S]*?)\nOPEN_AGENT_\w+\n/u.exec(script) ??
        [];

      expect(Buffer.from(encoded ?? '', 'base64')).toEqual(expected);
      expect(script).toContain("'APP_MODE=two '\\'' words'");
      expect(script).not.toContain(text);
      expect(script).toContain(receiver);
    },
  );

  it.each<{ reason: string; command: SessionCommand; error: RegExp }>([
    {
      reason: 'NUL',
      error: /NUL/u,
      command: { ...command, argv: ['/bin/cat', 'bad\0word'] },
    },
    {
      reason: 'assignment',
      error: /MODE=bad/u,
      command: { ...command, argv: ['MODE=bad'] },
    },
    {
      reason: 'variable',
      error: /invalid-name/u,
      command: { ...command, environment: { 'invalid-name': 'value' } },
    },
    {
      reason: 'reserved variable',
      error: /OPEN_AGENT_SECRET_FILE/u,
      command: {
        ...command,
        environment: { OPEN_AGENT_SECRET_FILE: '/untrusted' },
      },
    },
    {
      reason: 'timeout',
      error: /timeout/u,
      command: { ...command, timeoutMs: 0 },
    },
  ] satisfies Array<{
    reason: string;
    command: SessionCommand;
    error: RegExp;
  }>)(
    'should reject a command that cannot be framed safely ($reason)',
    ({ command, error }) => {
      expect(() => commandScript({ ...frame, command })).toThrow(error);
    },
  );
});

describe('fn:openBody', () => {
  it('should identify the session being superseded in the generated replacement', () => {
    expect(openBody({ sessionCommands: ['flock'], supersedes: 51 })).toMatch(
      /elif test "\$oa_session_shell" = 51; then/u,
    );
  });
});
