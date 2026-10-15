import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CLAUDE_SETTINGS } from '#drivers/harnesses/claude/paths';
import { CODEX_CONFIG } from '#drivers/harnesses/codex/paths';
import { setupAll } from '#setup/all';

import { profileWith } from '../fixtures/profile.js';
import {
  createFilesystemSprite,
  guestOf,
  workstationOf,
} from '../mocks/sprites.js';

import type { SetupContext } from '#setup/context';

describe('fn:setupAll', () => {
  it('should apply native proxy settings before rejecting a restricted env file and before services or exposure', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-setup-order-'),
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
      network: false,
      exitNode: false,
      cliproxyapi: true,
    };
    const context: SetupContext = {
      ...workstationOf(sprite),
      options: {
        envFile: envPath,
        github: false,
        gitIdentity: false,
        plugins: false,
        localCredentials: false,
        nonInteractive: true,
      },
      input: {
        profile: profileWith(integrations),
        runtimeEnv: {},
        sources: {},
        missing: [],
        proxyUrl: 'https://proxy.example/v1',
        proxyApiKey: 'client-key',
      },
      profile: profileWith(integrations),
      persistsProfile: false,
      isReleaseChanged: false,
      networkEnrolled: false,
      mutation: { started: false },
    };
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
    await sprite.filesystem().writeJSON('/opt/open-agent/manifest.json', {
      schema: 1,
      createdAt: '2026-10-09T00:00:00Z',
      installedVersions: {},
      profile: profileWith(integrations),
    });

    await expect(setupAll(guestOf(sprite), context)).rejects.toMatchObject({
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
