import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse, stringify } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import { applyClaudePlugins } from '#integrations/native/claude';
import { applyCodexPlugins } from '#integrations/native/codex';
import {
  CLAUDE_PLUGIN_STATE,
  CODEX_CONFIG,
  CODEX_PLUGIN_STATE,
} from '#integrations/native/configuration';
import {
  installedPlugins,
  marketplaceMatches,
  marketplaces,
} from '#integrations/native/plugin-state';

import {
  createFilesystemSprite,
  executeNativeConfiguration,
} from '../../mocks/sprites.js';

import type { ExecResult, Sprite } from '@fly/sprites';

describe('fn:installedPlugins', () => {
  it('should map Claude and Codex native inventory identities and enablement', () => {
    expect(
      installedPlugins(
        '[{"id":"claude@market","enabled":true},{"id":"disabled@market","enabled":false}]',
        'claude',
      ),
    ).toEqual([
      { id: 'claude@market', enabled: true },
      { id: 'disabled@market', enabled: false },
    ]);
    expect(
      installedPlugins(
        '{"installed":[{"pluginId":"codex@market","enabled":true},{"pluginId":"disabled@market","enabled":false}]}',
        'codex',
      ),
    ).toEqual([
      { id: 'codex@market', enabled: true },
      { id: 'disabled@market', enabled: false },
    ]);
  });

  it('should reject partial inventories instead of accepting missing or invalid native fields', () => {
    for (const output of [
      '{}',
      '[null]',
      '[{"id":3,"enabled":true}]',
      '[{"id":"plugin","enabled":"yes"}]',
    ]) {
      expect(() => installedPlugins(output, 'claude')).toThrow(
        expect.objectContaining({ code: 'PROVIDER' }),
      );
    }
    for (const output of [
      'null',
      '{"installed":{}}',
      '{"installed":[{"pluginId":3,"enabled":true}]}',
    ]) {
      expect(() => installedPlugins(output, 'codex')).toThrow(
        expect.objectContaining({ code: 'PROVIDER' }),
      );
    }
  });

  it('should keep invalid native JSON private while classifying the provider failure', () => {
    for (const harness of ['claude', 'codex'] as const) {
      expect(() => installedPlugins('{private-body', harness)).toThrow(
        expect.objectContaining({
          code: 'PROVIDER',
          cause: expect.any(SyntaxError),
          causeVisibility: 'private',
          message: expect.not.stringContaining('private-body'),
        }),
      );
    }
  });
});

describe('fn:marketplaceMatches', () => {
  it('should compare native marketplace names and equivalent GitHub repository identities without accepting unrelated values', () => {
    expect(marketplaceMatches({ name: 'selected' }, 'selected')).toBe(true);
    expect(
      marketplaceMatches(
        { name: 'other', repo: 'https://github.com/Owner/Repo.git' },
        'owner/repo/',
      ),
    ).toBe(true);
    expect(
      marketplaceMatches(
        { marketplaceSource: { source: 'OWNER/REPO' } },
        'https://github.com/owner/repo',
      ),
    ).toBe(true);
    expect(marketplaceMatches({ repo: 'owner/other' }, 'owner/repo')).toBe(
      false,
    );
    expect(marketplaceMatches({ repo: 1 }, 'owner/repo')).toBe(false);
    expect(marketplaceMatches({ marketplaceSource: {} }, 'owner/repo')).toBe(
      false,
    );
    expect(marketplaceMatches(null, 'owner/repo')).toBe(false);
  });
});

describe('fn:marketplaces', () => {
  it('should read both native inventory formats and reject malformed records', () => {
    const record = { name: 'selected', repo: 'owner/repo' };

    expect(marketplaces(JSON.stringify([record]), 'claude')).toEqual([record]);
    expect(
      marketplaces(JSON.stringify({ marketplaces: [record] }), 'codex'),
    ).toEqual([record]);
    expect(marketplaces('[]', 'codex')).toEqual([]);
    for (const output of ['{}', '[null]']) {
      expect(() => marketplaces(output, 'claude')).toThrow(
        expect.objectContaining({ code: 'PROVIDER' }),
      );
    }
    expect(() => marketplaces('{"marketplaces":{}}', 'codex')).toThrow(
      expect.objectContaining({ code: 'PROVIDER' }),
    );
  });

  it('should keep invalid marketplace JSON as a private cause', () => {
    for (const harness of ['claude', 'codex'] as const) {
      expect(() => marketplaces('{private-body', harness)).toThrow(
        expect.objectContaining({
          code: 'PROVIDER',
          cause: expect.any(SyntaxError),
          causeVisibility: 'private',
          message: expect.not.stringContaining('private-body'),
        }),
      );
    }
  });
});

const boundary = {
  execFile: async (file: string, args: string[] = []): Promise<ExecResult> => {
    const harness = args.includes('claude')
      ? 'claude'
      : args.includes('codex')
        ? 'codex'
        : undefined;
    if (harness && args.includes('plugin') && args.includes('list')) {
      const identities = [
        { id: `selected@${harness}-market`, enabled: true },
        { id: `previous@${harness}-market`, enabled: true },
        { id: 'unrelated@user-market', enabled: true },
      ];
      const response = args.includes('marketplace')
        ? harness === 'claude'
          ? []
          : { marketplaces: [] }
        : harness === 'claude'
          ? identities
          : {
              installed: identities.map(({ id, enabled }) => ({
                pluginId: id,
                enabled,
              })),
            };

      return { stdout: JSON.stringify(response), stderr: '', exitCode: 0 };
    }

    return executeNativeConfiguration(file, args);
  },
} satisfies Partial<Sprite>;

describe('independent native plugin selection', () => {
  it('should persist only each harness selected identities and preserve unrelated Codex plugin settings', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-plugins-'),
    );
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: boundary.execFile,
    });
    const filesystem = sprite.filesystem();
    await filesystem.mkdir('/home/agent/.codex', { recursive: true });
    await filesystem.mkdir('/opt/agent-sprite', { recursive: true });
    await filesystem.writeFile(
      CLAUDE_PLUGIN_STATE,
      JSON.stringify(['previous@claude-market', 'missing@claude-market']),
    );
    await filesystem.writeFile(
      CODEX_PLUGIN_STATE,
      JSON.stringify(['previous@codex-market']),
    );
    await filesystem.writeFile(
      CODEX_CONFIG,
      stringify({
        model: 'user-model',
        plugins: {
          'unrelated@user-market': { enabled: false, userSetting: 'retained' },
        },
      }),
    );
    const emptyActions = {
      marketplaces: [],
      removeMarketplaces: [],
      disablePlugins: [],
      uninstallPlugins: [],
    };

    await applyClaudePlugins(sprite, {
      ...emptyActions,
      plugins: ['selected@claude-market'],
    });
    await applyCodexPlugins(sprite, {
      ...emptyActions,
      plugins: ['selected@codex-market'],
    });

    expect(
      JSON.parse(
        await readFile(join(directory.path, CLAUDE_PLUGIN_STATE), 'utf8'),
      ),
    ).toEqual(['previous@claude-market', 'selected@claude-market']);
    expect(
      JSON.parse(
        await readFile(join(directory.path, CODEX_PLUGIN_STATE), 'utf8'),
      ),
    ).toEqual(['previous@codex-market', 'selected@codex-market']);
    expect(
      parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
    ).toEqual({
      model: 'user-model',
      plugins: {
        'unrelated@user-market': { enabled: false, userSetting: 'retained' },
        'selected@codex-market': { enabled: true },
      },
    });
  });
});
