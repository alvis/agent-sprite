import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServiceLogStream } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { setupT3 } from '#setup/sections';
import { PairingSecret } from '#utilities/pairing-secret';

import { createFilesystemSprite } from '../mocks/sprites.js';

import type { SetupContext } from '#setup/context';

const integrations = { tailscale: false, exitNode: false, cliproxyapi: false };

describe('fn:setupT3', () => {
  it('should mint zero codes when omitted and exactly one when requested', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-setup-t3-'),
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
    await sprite.filesystem().mkdir('/opt/agent-sprite', {
      recursive: true,
    });
    await sprite.filesystem().mkdir('/opt/agent-sprite/t3-provider-probe', {
      recursive: true,
    });
    await sprite.filesystem().mkdir('/etc/cron.d', { recursive: true });
    await sprite.filesystem().writeJSON('/opt/agent-sprite/manifest.json', {
      schema: 1,
      createdAt: '2026-10-09T00:00:00Z',
      installedVersions: {},
      integrations,
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
      options: {},
      input: { integrations, runtimeEnv: {}, sources: {}, missing: [] },
      integrations,
      tailscaleEnrolled: false,
      initialInstallation: false,
      mutation: { started: false },
    };

    const ordinary = await setupT3(sprite, context);

    expect(ordinary).toEqual({
      service: 'configured',
      pairing: { status: 'not requested' },
    });
    expect(context.mutation.started).toBe(true);
    const calls = vi.mocked(sprite.execFile).mock.calls;
    expect(calls.filter(([, args]) => args?.includes('pair'))).toHaveLength(0);

    context.options = { withT3PairCode: true };
    context.mutation.started = false;
    const requested = await setupT3(sprite, context);

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
