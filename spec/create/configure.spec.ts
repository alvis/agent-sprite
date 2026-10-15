import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { configureNewWorkstation } from '#create/configure';
import { CODEX_CONFIG } from '#drivers/harnesses/codex/paths';

import { DISABLED_NETWORK_PROFILE } from '../fixtures/profile.js';
import { createFilesystemSprite, guestOf } from '../mocks/sprites.js';

const emptyActions = {
  marketplaces: [],
  plugins: [],
  removeMarketplaces: [],
  disablePlugins: [],
  uninstallPlugins: [],
};

describe('fn:configureNewWorkstation', () => {
  it('should reject restricted runtime variables before native proxy settings or services', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-create-order-'),
    );
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: async () => ({ stdout: '24.0.0\n', stderr: '', exitCode: 0 }),
    });
    const services = vi.spyOn(sprite, 'listServices');
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
    await sprite.filesystem().mkdir('/run/lock', { recursive: true });

    await expect(
      configureNewWorkstation(guestOf(sprite), {
        hostname: sprite.name,
        profile: DISABLED_NETWORK_PROFILE,
        runtimeEnv: { PATH: '/untrusted/path' },
        plugins: { claude: emptyActions, codex: emptyActions },
      }),
    ).rejects.toMatchObject({ code: 'INPUT' });

    expect(
      await sprite.filesystem().exists('/opt/open-agent/manifest.json'),
    ).toBe(true);
    expect(
      await sprite.filesystem().exists('/home/agent/.claude/settings.json'),
    ).toBe(false);
    expect(await sprite.filesystem().exists(CODEX_CONFIG)).toBe(false);
    expect(services).not.toHaveBeenCalled();
  });
});
