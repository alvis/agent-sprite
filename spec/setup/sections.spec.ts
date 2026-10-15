import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServiceLogStream } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { setupAgent } from '#setup/sections';
import { PairingSecret } from '#utilities/pairing-secret';

import { DISABLED_NETWORK_PROFILE, profileWith } from '../fixtures/profile.js';
import {
  createFilesystemSprite,
  guestOf,
  workstationOf,
} from '../mocks/sprites.js';

import type { SetupContext } from '#setup/context';

const integrations = { network: false, exitNode: false, cliproxyapi: false };

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
    await sprite.filesystem().mkdir('/opt/open-agent', {
      recursive: true,
    });
    await sprite.filesystem().mkdir('/opt/open-agent/t3-environment-probe', {
      recursive: true,
    });
    await sprite.filesystem().mkdir('/etc/cron.d', { recursive: true });
    await sprite.filesystem().writeJSON('/opt/open-agent/manifest.json', {
      schema: 1,
      createdAt: '2026-10-09T00:00:00Z',
      installedVersions: {},
      profile: profileWith(integrations),
    });
    vi.spyOn(sprite, 'listServices').mockResolvedValue([]);
    vi.spyOn(sprite, 'getService').mockImplementation(async (name) => ({
      name,
      cmd: '/usr/bin/sudo',
      args: [],
      needs: [],
      state: { name, status: 'running' },
    }));
    vi.spyOn(sprite, 'createService').mockImplementation(
      async () =>
        new ServiceLogStream(
          new Response('{"type":"complete","timestamp":0}\n'),
        ),
    );
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

    const ordinary = await setupAgent(guestOf(sprite), context);

    expect(ordinary).toEqual({
      service: 'configured',
      pairing: { status: 'not requested' },
    });
    expect(context.mutation.started).toBe(true);
    const calls = vi.mocked(sprite.execFile).mock.calls;
    expect(calls.filter(([, args]) => args?.includes('pair'))).toHaveLength(0);

    context.options = { withPairCode: true };
    context.mutation.started = false;
    const requested = await setupAgent(guestOf(sprite), context);

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
