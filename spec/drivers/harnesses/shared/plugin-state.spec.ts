import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse, stringify } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_INVENTORY,
  CLAUDE_PLUGIN_STATE,
} from '#drivers/harnesses/claude/paths';
import { claudePlugins } from '#drivers/harnesses/claude/plugins';
import {
  CODEX_CONFIG,
  CODEX_INVENTORY,
  CODEX_PLUGIN_STATE,
} from '#drivers/harnesses/codex/paths';
import { codexPlugins } from '#drivers/harnesses/codex/plugins';
import {
  installedPlugins,
  marketplaceMatches,
  marketplaces,
} from '#drivers/harnesses/shared/plugin-state';

import {
  createFilesystemSprite,
  executeNativeConfiguration,
  guestOf,
} from '../../../mocks/sprites';

import type { ExecResult, Sprite } from '@fly/sprites';

const inventories = { claude: CLAUDE_INVENTORY, codex: CODEX_INVENTORY };
const applyClaudePlugins = claudePlugins.apply;
const applyCodexPlugins = codexPlugins.apply;

describe('fn:installedPlugins', () => {
  it('should map Claude and Codex native inventory identities and enablement', () => {
    expect(
      installedPlugins(
        '[{"id":"claude@market","enabled":true},{"id":"disabled@market","enabled":false}]',
        CLAUDE_INVENTORY,
      ),
    ).toEqual([
      { id: 'claude@market', enabled: true },
      { id: 'disabled@market', enabled: false },
    ]);
    expect(
      installedPlugins(
        '{"installed":[{"pluginId":"codex@market","enabled":true},{"pluginId":"disabled@market","enabled":false}]}',
        CODEX_INVENTORY,
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
      expect(() => installedPlugins(output, CLAUDE_INVENTORY)).toThrow(
        expect.objectContaining({ code: 'PROVIDER' }),
      );
    }
    for (const output of [
      'null',
      '{"installed":{}}',
      '{"installed":[{"pluginId":3,"enabled":true}]}',
    ]) {
      expect(() => installedPlugins(output, CODEX_INVENTORY)).toThrow(
        expect.objectContaining({ code: 'PROVIDER' }),
      );
    }
  });

  it('should keep invalid native JSON private while classifying the provider failure', () => {
    for (const harness of ['claude', 'codex'] as const) {
      expect(() =>
        installedPlugins('{private-body', inventories[harness]),
      ).toThrow(
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

    expect(marketplaces(JSON.stringify([record]), CLAUDE_INVENTORY)).toEqual([
      record,
    ]);
    expect(
      marketplaces(JSON.stringify({ marketplaces: [record] }), CODEX_INVENTORY),
    ).toEqual([record]);
    expect(marketplaces('[]', CODEX_INVENTORY)).toEqual([]);
    for (const output of ['{}', '[null]']) {
      expect(() => marketplaces(output, CLAUDE_INVENTORY)).toThrow(
        expect.objectContaining({ code: 'PROVIDER' }),
      );
    }
    expect(() => marketplaces('{"marketplaces":{}}', CODEX_INVENTORY)).toThrow(
      expect.objectContaining({ code: 'PROVIDER' }),
    );
  });

  it('should keep invalid marketplace JSON as a private cause', () => {
    for (const harness of ['claude', 'codex'] as const) {
      expect(() => marketplaces('{private-body', inventories[harness])).toThrow(
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
      join(tmpdir(), 'open-agent-plugins-'),
    );
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: boundary.execFile,
    });
    const filesystem = sprite.filesystem();
    await filesystem.mkdir('/home/agent/.codex', { recursive: true });
    await filesystem.mkdir('/opt/open-agent', { recursive: true });
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

    await applyClaudePlugins(guestOf(sprite), {
      ...emptyActions,
      plugins: ['selected@claude-market'],
    });
    await applyCodexPlugins(guestOf(sprite), {
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
