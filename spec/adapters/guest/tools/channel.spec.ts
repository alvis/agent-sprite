import { describe, expect, it, vi } from 'vitest';

import { inspectAgentRelease } from '#adapters/guest/tools/channel';
import { defaults } from '#composition/defaults';
import { registry } from '#composition/registry';
import { defaultProfile } from '#domain/profile';

import type { SetupSession } from '#application/ports/session';

const release = {
  family: 'debian',
  id: 'debian',
  versionId: '12',
  arch: 'x86_64',
  libc: 'glibc',
} as const;
const run = vi.fn<SetupSession['run']>(async () => ({
  exitCode: 0,
  stdout: 'tagged=2.0.0\n',
  stderr: '',
}));
const guestSession = {
  release,
  pid: 51,
  run,
  [Symbol.asyncDispose]: async () => undefined,
};
const session = {
  open: vi.fn(async () => guestSession),
  run,
} satisfies Partial<SetupSession>;
const profile = defaultProfile(defaults);

describe('fn:inspectAgentRelease', () => {
  it('should report an untracked agent without opening the guest', async () => {
    const custom = {
      agents: {
        t3: { ...registry.agents.t3, tools: [] },
      },
    };
    await expect(
      inspectAgentRelease(
        custom,
        session as Partial<SetupSession> as SetupSession,
        profile,
      ),
    ).resolves.toEqual({ status: 'untracked' });
    expect(session.open).not.toHaveBeenCalled();
  });

  it('should report the tagged release when no installed version was reported', async () => {
    await expect(
      inspectAgentRelease(
        registry,
        session as Partial<SetupSession> as SetupSession,
        profile,
      ),
    ).resolves.toEqual({ status: 'known', tagged: '2.0.0' });
  });

  it.each([
    {
      reason: 'npm code',
      exitCode: 1,
      stderr:
        'npm error request refused\nnpm error code E403\nnpm error log file: private',
      message: /npm error code E403/u,
    },
    {
      reason: 'npm message',
      exitCode: 1,
      stderr: '  npm error request refused\nnpm error log file: private',
      message: /npm error request refused/u,
    },
    {
      reason: 'other process error',
      exitCode: 1,
      stderr: '  connection failed\nprivate diagnostic',
      message: /connection failed/u,
    },
    {
      reason: 'missing tagged result',
      exitCode: 0,
      stderr: '',
      message: /could not read.*exit 0/u,
    },
  ])(
    'should report a useful reason when release inspection is inconclusive ($reason)',
    async ({ exitCode, stderr, message }) => {
      run.mockResolvedValueOnce({ exitCode, stdout: '', stderr });
      await expect(
        inspectAgentRelease(
          registry,
          session as Partial<SetupSession> as SetupSession,
          profile,
        ),
      ).resolves.toEqual({
        status: 'unknown',
        reason: expect.stringMatching(message),
      });
    },
  );
});
