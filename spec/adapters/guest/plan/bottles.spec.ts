import { describe, expect, it, vi } from 'vitest';

import { assemblePlan } from '#adapters/guest/plan/assembly';
import { probeBottles } from '#adapters/guest/plan/bottles';
import { registry } from '#composition/registry';
import { OPEN_AGENT_VERSION } from '#kernel/version';

import { DISABLED_NETWORK_PROFILE } from '../../../fixtures/profile';

import type { GuestSession } from '#application/ports/session';

describe('fn:probeBottles', () => {
  it('should return no refusals without running a probe when no formula is resolved', async () => {
    const assembly = await assemblePlan(registry, {
      provider: registry.providers.sprite,
      profile: DISABLED_NETWORK_PROFILE,
      release: {
        family: 'debian',
        id: 'debian',
        versionId: '12',
        arch: 'x86_64',
        libc: 'glibc',
      },
      version: OPEN_AGENT_VERSION,
      setupAt: '2026-10-25T00:00:00Z',
    });
    const session = {
      run: vi.fn<GuestSession['run']>(async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
      })),
    } satisfies Pick<GuestSession, 'run'>;

    const refused = await probeBottles(session, {
      ...assembly,
      resolutions: [],
    });

    expect(refused).toEqual([]);
    expect(session.run).not.toHaveBeenCalled();
  });

  it('should turn an unbottled formula reported by Homebrew into a refused source', async () => {
    const assembly = await assemblePlan(registry, {
      provider: registry.providers.sprite,
      profile: DISABLED_NETWORK_PROFILE,
      release: {
        family: 'debian',
        id: 'debian',
        versionId: '12',
        arch: 'x86_64',
        libc: 'glibc',
      },
      version: OPEN_AGENT_VERSION,
      setupAt: '2026-10-25T00:00:00Z',
    });
    const session = {
      run: async () => ({
        exitCode: 0,
        stdout: 'diagnostic\nno-bottle:jq\n',
        stderr: '',
      }),
    } satisfies Pick<GuestSession, 'run'>;

    const refused = await probeBottles(session, assembly);

    expect(refused).toEqual([
      {
        tool: 'jq',
        source: { kind: 'brew', formula: 'jq' },
        reason: expect.stringContaining('no bottle'),
      },
    ]);
  });

  it.each([
    { stderr: 'brew unavailable', details: ['brew unavailable'] },
    { stderr: '', details: [] },
  ])(
    'should report a failed bottle probe with bounded error evidence: %j',
    async ({ stderr, details }) => {
      const assembly = await assemblePlan(registry, {
        provider: registry.providers.sprite,
        profile: DISABLED_NETWORK_PROFILE,
        release: {
          family: 'debian',
          id: 'debian',
          versionId: '12',
          arch: 'x86_64',
          libc: 'glibc',
        },
        version: OPEN_AGENT_VERSION,
        setupAt: '2026-10-25T00:00:00Z',
      });
      const session = {
        run: async () => ({ exitCode: 1, stdout: '', stderr }),
      } satisfies Pick<GuestSession, 'run'>;

      await expect(probeBottles(session, assembly)).rejects.toMatchObject({
        code: 'PROVIDER',
        details,
      });
    },
  );
});
