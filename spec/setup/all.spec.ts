import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CLAUDE_SETTINGS } from '#drivers/harnesses/claude/paths';
import { CODEX_CONFIG } from '#drivers/harnesses/codex/paths';
import { setupAll } from '#setup/all';

import { profileWith } from '../fixtures/profile';
import { createFilesystemSprite, workstationOf } from '../mocks/sprites';

import type { SetupContext } from '#setup/context';

// setup's root session is a framed guest shell only the live specs open
vi.mock(
  '#integrations/guest/session/open',
  async () => import('../mocks/session'),
);
// Codex trusts its hooks through its app server, a guest process only the live specs run
vi.mock('#drivers/harnesses/codex/hook-trust', () => ({
  trustCodexHooks: vi.fn(async () => undefined),
}));

describe('fn:setupAll', () => {
  it('should name the guest and apply native proxy settings before rejecting a restricted env file and before services or exposure', async () => {
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

    await expect(
      setupAll(await context.connection.guest(), context),
    ).rejects.toMatchObject({
      code: 'INPUT',
    });

    expect(
      await sprite.filesystem().exists('/opt/open-agent/workstation-name'),
    ).toBe(true);
    expect(await sprite.filesystem().exists(CLAUDE_SETTINGS)).toBe(true);
    expect(await sprite.filesystem().exists(CODEX_CONFIG)).toBe(true);
    expect(
      await sprite.filesystem().exists('/home/agent/.codex/hooks.json'),
    ).toBe(true);
    expect(services).not.toHaveBeenCalled();
    expect(exposure).not.toHaveBeenCalled();
  });
});
