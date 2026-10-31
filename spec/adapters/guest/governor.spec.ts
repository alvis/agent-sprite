import { describe, expect, it, vi } from 'vitest';

import { inspectGovernor, sessionAwakeHold } from '#adapters/guest/governor';

import type { GuestChannel } from '#application/ports/guest-channel';

describe('fn:inspectGovernor', () => {
  it('should preserve the reason from a validated governor report', async () => {
    const report = {
      recorded: false,
      reason: 'the guest has no governor record yet',
    };
    const guest = {
      exec: vi.fn<GuestChannel['exec']>(async () => ({
        exitCode: 0,
        stdout: JSON.stringify(report),
        stderr: '',
      })),
    } satisfies Partial<GuestChannel> as Partial<GuestChannel> as GuestChannel;

    await expect(inspectGovernor(guest)).resolves.toEqual(report);
  });

  it.each([
    { exitCode: 1, stdout: 'not JSON' },
    { exitCode: 0, stdout: 'not JSON' },
    { exitCode: 0, stdout: '{}' },
  ])(
    'should report unavailable governor evidence for $exitCode / $stdout',
    async (result) => {
      const guest = {
        exec: vi.fn<GuestChannel['exec']>(async () => ({
          ...result,
          stderr: '',
        })),
      } satisfies Partial<GuestChannel> as Partial<GuestChannel> as GuestChannel;

      await expect(inspectGovernor(guest)).resolves.toEqual({
        recorded: false,
        reason: expect.any(String),
      });
    },
  );
});

describe('session awake holds', () => {
  it.each(['open', 'close'] as const)(
    'should %s a hold bound to the session process',
    (action) => {
      expect(sessionAwakeHold[action](42)).toEqual({
        argv: [
          '/opt/open-agent/governor/awake.sh',
          `hold-${action}`,
          '--source',
          'session',
          '--session',
          'session-42',
          '--pid',
          '42',
        ],
        account: 'root',
        timeoutMs: expect.any(Number),
      });
    },
  );
});
