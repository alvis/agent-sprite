import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_SETTINGS,
  CODEX_CONFIG,
} from '#integrations/native/configuration';
import { setupAll } from '#setup/all';

import { createFilesystemSprite } from '../mocks/sprites.js';

import type { SetupContext } from '#setup/context';

describe('fn:setupAll', () => {
  it('should apply native proxy settings before rejecting a restricted env file and before services or exposure', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-setup-order-'),
    );
    const envPath = join(directory.path, 'restricted.env');
    await writeFile(envPath, 'PATH=/untrusted/path\n');
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    });
    const services = vi.spyOn(sprite, 'listServices');
    const exposure = vi.spyOn(sprite, 'updateURLSettings');
    const integrations = {
      tailscale: false,
      exitNode: false,
      cliproxyapi: true,
    };
    const context: SetupContext = {
      options: {
        env: envPath,
        github: false,
        gitIdentity: false,
        plugins: false,
        localCredentials: false,
        nonInteractive: true,
      },
      input: {
        integrations,
        runtimeEnv: {},
        sources: {},
        missing: [],
        proxyUrl: 'https://proxy.example/v1',
        proxyApiKey: 'client-key',
      },
      integrations,
      tailscaleEnrolled: false,
      initialInstallation: false,
      mutation: { started: false },
    };
    await sprite.filesystem().mkdir('/opt/agent-sprite', { recursive: true });
    await sprite.filesystem().writeJSON('/opt/agent-sprite/manifest.json', {
      schema: 1,
      createdAt: '2026-10-09T00:00:00Z',
      installedVersions: {},
      integrations,
    });

    await expect(setupAll(sprite, context)).rejects.toMatchObject({
      code: 'INPUT',
    });

    expect(await sprite.filesystem().exists(CLAUDE_SETTINGS)).toBe(true);
    expect(await sprite.filesystem().exists(CODEX_CONFIG)).toBe(true);
    expect(
      await sprite.filesystem().exists('/home/agent/.codex/hooks.json'),
    ).toBe(true);
    expect(services).not.toHaveBeenCalled();
    expect(exposure).not.toHaveBeenCalled();
  });
});
