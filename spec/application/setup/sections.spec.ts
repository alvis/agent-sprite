import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  setupAgent,
  setupEnvironment,
  setupGit,
} from '#application/setup/sections';

import { PairingSecret } from '#kernel/pairing-secret';

import { DISABLED_NETWORK_PROFILE } from '../../fixtures/profile';

import { dependencies } from '../../mocks/dependencies';
import {
  createFilesystemSprite,
  holdServices,
  workstationOf,
} from '../../mocks/sprites';

import type { GuestChannel } from '#application/ports/guest-channel';
import type { SetupContext } from '#application/setup/context';

// setup's root session is a framed guest shell only the live specs open
vi.mock(
  '#adapters/guest/platform/session/open',
  async () => import('../../mocks/session'),
);
// Codex trusts its hooks through its app server, a guest process only the live specs run
vi.mock('#adapters/drivers/harnesses/codex/hook-trust', () => ({
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
      dependencies,
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
      dependencies,
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

/**
 * builds a setup context over a guest that runs nothing
 * @param options parsed setup flags
 * @returns the context and its guest
 */
async function quietSetup(
  options: SetupContext['options'],
): Promise<{ context: SetupContext; guest: GuestChannel }> {
  const sprite = createFilesystemSprite({
    root: tmpdir(),
    execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  });
  const context: SetupContext = {
    ...workstationOf(sprite),
    options,
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

  return { context, guest: await context.connection.guest() };
}

describe('fn:setupEnvironment', () => {
  it('should skip the section without --env-file when it cannot prompt', async () => {
    const { context, guest } = await quietSetup({ nonInteractive: true });

    const result = await setupEnvironment(dependencies, guest, context);

    expect(result).toEqual({ runtimeEnvironment: { status: 'skipped' } });
    expect(context.mutation.started).toBe(false);
  });
});

describe('fn:setupGit', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should name every source of a missing Git identity before changing the guest', async () => {
    vi.stubEnv('GIT_AUTHOR_NAME', undefined);
    vi.stubEnv('GIT_AUTHOR_EMAIL', undefined);
    vi.stubEnv('GIT_COMMITTER_NAME', undefined);
    vi.stubEnv('GIT_COMMITTER_EMAIL', undefined);
    const { context, guest } = await quietSetup({
      nonInteractive: true,
      localCredentials: false,
    });

    await expect(setupGit(dependencies, guest, context)).rejects.toMatchObject({
      code: 'INPUT',
      message: 'Required setup inputs are missing',
      details: [
        'Git author identity is not set. Set GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL or pass --env-file FILE ' +
          'containing GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL; use --git-name NAME and --git-email EMAIL; ' +
          'or run in a TTY to enter it when prompted. Or pass --no-git-identity to leave it unset.',
      ],
    });
    expect(context.mutation.started).toBe(false);
  });
});
