import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { setupAgent } from '#setup/sections';
import { PairingSecret } from '#utilities/pairing-secret';

import { DISABLED_NETWORK_PROFILE } from '../fixtures/profile.js';
import {
  createFilesystemSprite,
  holdServices,
  workstationOf,
} from '../mocks/sprites.js';

import type { SetupContext } from '#setup/context';

// setup's root session is a framed guest shell only the live specs open
vi.mock(
  '#integrations/guest/session/open',
  async () => import('../mocks/session.js'),
);
// Codex trusts its hooks through its app server, a guest process only the live specs run
vi.mock('#drivers/harnesses/codex/hook-trust', () => ({
  trustCodexHooks: vi.fn(async () => undefined),
}));

describe('fn:setupAgent', () => {
  it('should mint zero codes when omitted and exactly one when requested', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-setup-t3-'),
    );
    const token = 'setup-t3-requested-pairing';
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: async (_file, args = []) => ({
        stdout: args.includes('/usr/bin/id')
          ? '1000'
          : args.includes('--help')
            ? '--log-level --no-browser'
            : args.includes('pair')
              ? `Token: ${token}\nExpires: 2099-01-01T00:00:00Z\n`
              : '',
        stderr: '',
        exitCode: 0,
      }),
    });
    holdServices(sprite);
    const context: SetupContext = {
      ...workstationOf(sprite),
      options: {},
      input: {
        profile: DISABLED_NETWORK_PROFILE,
        runtimeEnv: {},
        sources: {},
        missing: [],
      },
      profile: DISABLED_NETWORK_PROFILE,
      persistsProfile: false,
      isReleaseChanged: false,
      networkEnrolled: false,
      mutation: { started: false },
    };

    const ordinary = await setupAgent(
      await context.connection.guest(),
      context,
    );

    expect(ordinary).toEqual({
      service: 'configured',
      pairing: { status: 'not requested' },
    });
    expect(context.mutation.started).toBe(true);
    const calls = vi.mocked(sprite.execFile).mock.calls;
    expect(calls.filter(([, args]) => args?.includes('pair'))).toHaveLength(0);

    context.options = { withPairCode: true };
    context.mutation.started = false;
    const requested = await setupAgent(
      await context.connection.guest(),
      context,
    );

    expect(requested).toMatchObject({
      pairing: {
        status: 'created',
        expiresAt: '2099-01-01T00:00:00Z',
        token: expect.any(PairingSecret),
      },
    });
    expect(requested.pairing.token?.disclose(true)).toBe(token);
    expect(context.mutation.started).toBe(false);
    expect(calls.filter(([, args]) => args?.includes('pair'))).toHaveLength(1);
  });
});
