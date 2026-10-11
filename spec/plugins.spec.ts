import { describe, expect, it } from 'vitest';

import {
  hasActions,
  hasExplicitPluginActions,
  resolvePluginActions,
  validateMarketplaceSources,
} from '#plugins';

import type { CommandOptions } from '#command';

const emptyActions = {
  marketplaces: [],
  plugins: [],
  removeMarketplaces: [],
  disablePlugins: [],
  uninstallPlugins: [],
};

describe('fn:resolvePluginActions', () => {
  it('should preserve separate harness actions and use marketplace inheritance only when requested', () => {
    const selections = {
      claudeMarketplace: ['claude/source'],
      claudePlugin: ['alpha@claude'],
      codexPlugin: ['beta@codex'],
      removeClaudeMarketplace: ['claude-old'],
      disableCodexPlugin: ['codex-off'],
      uninstallClaudePlugin: ['claude-gone'],
    };

    expect(resolvePluginActions(selections)).toEqual({
      claude: {
        marketplaces: ['claude/source'],
        plugins: ['alpha@claude'],
        removeMarketplaces: ['claude-old'],
        disablePlugins: [],
        uninstallPlugins: ['claude-gone'],
      },
      codex: {
        marketplaces: [],
        plugins: ['beta@codex'],
        removeMarketplaces: [],
        disablePlugins: ['codex-off'],
        uninstallPlugins: [],
      },
    });
    expect(
      resolvePluginActions({ ...selections, reuseClaudeMarketplaces: true })
        .codex,
    ).toEqual({
      marketplaces: ['claude/source'],
      plugins: ['beta@codex'],
      removeMarketplaces: [],
      disablePlugins: ['codex-off'],
      uninstallPlugins: [],
    });
    expect(resolvePluginActions({ plugins: false })).toEqual({
      claude: emptyActions,
      codex: emptyActions,
    });
    expect(
      resolvePluginActions({ claudePlugins: false, codexPlugins: false }),
    ).toEqual({ claude: emptyActions, codex: emptyActions });
  });

  it('should reject skips that conflict with explicit changes or inheritance', () => {
    const conflicts: CommandOptions[] = [
      { plugins: false, claudePlugin: ['alpha@market'] },
      { plugins: false, codexPlugin: ['beta@market'] },
      { plugins: false, reuseClaudeMarketplaces: true },
      { claudePlugins: false, claudeMarketplace: ['claude/source'] },
      { codexPlugins: false, codexPlugin: ['beta@market'] },
      { codexPlugins: false, reuseClaudeMarketplaces: true },
      { reuseClaudeMarketplaces: true, codexMarketplace: ['codex/source'] },
    ];

    for (const options of conflicts) {
      expect(() => resolvePluginActions(options)).toThrow(
        expect.objectContaining({ code: 'USAGE' }),
      );
    }
  });
});

describe('fn:hasActions', () => {
  it('should distinguish every native action from preserving existing state', () => {
    expect([
      hasActions(emptyActions),
      hasActions({ ...emptyActions, marketplaces: ['market'] }),
      hasActions({ ...emptyActions, plugins: ['plugin@market'] }),
      hasActions({ ...emptyActions, removeMarketplaces: ['market'] }),
      hasActions({ ...emptyActions, disablePlugins: ['plugin@market'] }),
      hasActions({ ...emptyActions, uninstallPlugins: ['plugin@market'] }),
    ]).toEqual([false, true, true, true, true, true]);
    expect([
      hasExplicitPluginActions({}),
      hasExplicitPluginActions({ plugins: false }),
      hasExplicitPluginActions({ claudePlugin: [] }),
      hasExplicitPluginActions({ uninstallCodexPlugin: ['plugin@market'] }),
      hasExplicitPluginActions({ reuseClaudeMarketplaces: true }),
    ]).toEqual([false, false, false, true, true]);
  });
});

describe('fn:validateMarketplaceSources', () => {
  it('should reject credential-bearing and unsupported sources before network access', async () => {
    await expect(
      validateMarketplaceSources(
        { claude: emptyActions, codex: emptyActions },
        undefined,
        true,
      ),
    ).resolves.toBeUndefined();
    await expect(
      validateMarketplaceSources({
        claude: {
          ...emptyActions,
          marketplaces: [
            'https://private-user:private-password@example.test/source',
          ],
        },
        codex: emptyActions,
      }),
    ).rejects.toMatchObject({
      code: 'INPUT',
      message: expect.not.stringMatching(/private-user|private-password/),
    });
    await expect(
      validateMarketplaceSources({
        claude: emptyActions,
        codex: { ...emptyActions, marketplaces: ['not-a-repository'] },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'INPUT' }));
    await expect(
      validateMarketplaceSources(
        {
          claude: { ...emptyActions, plugins: ['absent@market'] },
          codex: emptyActions,
        },
        undefined,
        true,
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'INPUT' }));
  });
});
