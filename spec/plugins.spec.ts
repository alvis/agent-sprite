import { describe, expect, it } from 'vitest';

import {
  hasActions,
  hasExplicitPluginActions,
  normalizePluginOptions,
  resolvePluginActions,
  validateMarketplaceSources,
} from '#plugins';

import { pluginFlags } from './fixtures/plugin-flags.js';

import type { CommandOptions } from '#command';
import type { HarnessId } from '#core/catalog';
import type { HarnessPluginActions } from '#plugins';

const emptyActions = {
  marketplaces: [],
  plugins: [],
  removeMarketplaces: [],
  disablePlugins: [],
  uninstallPlugins: [],
};

/**
 * resolves parsed plugin flags the way create and setup do
 * @param options parsed plugin flags
 * @param harnesses selected harnesses
 * @returns native actions for each harness
 */
function resolveFlags(
  options: CommandOptions,
  harnesses?: readonly HarnessId[],
): HarnessPluginActions {
  return resolvePluginActions(normalizePluginOptions(options), harnesses);
}

/**
 * checks parsed plugin flags for explicit native actions
 * @param options parsed plugin flags
 * @returns whether explicit native plugin actions were requested
 */
function hasExplicitFlags(options: CommandOptions): boolean {
  return hasExplicitPluginActions(normalizePluginOptions(options));
}

describe('fn:normalizePluginOptions', () => {
  it('should mark every harness skipped by --no-plugins as one kind', () => {
    expect(normalizePluginOptions({ plugins: false })).toMatchObject({
      kind: 'skipped',
      harnesses: {
        claude: { skipped: false, marketplaces: [] },
        codex: { skipped: false, marketplaces: [] },
      },
      reuseMarketplacesSet: false,
    });
    expect(
      normalizePluginOptions(
        pluginFlags({ codexPlugins: false, reuseMarketplaces: false }),
      ),
    ).toMatchObject({
      kind: 'selected',
      harnesses: { codex: { skipped: true } },
      reuseMarketplaces: false,
      reuseMarketplacesSet: true,
    });
  });
});

describe('fn:resolvePluginActions', () => {
  it('should preserve separate harness actions and use marketplace inheritance only when requested', () => {
    const selections = pluginFlags({
      claudeMarketplace: ['claude/source'],
      claudePlugin: ['alpha@claude'],
      codexPlugin: ['beta@codex'],
      removeClaudeMarketplace: ['claude-old'],
      disableCodexPlugin: ['codex-off'],
      uninstallClaudePlugin: ['claude-gone'],
    });

    expect(resolveFlags(selections)).toEqual({
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
      resolveFlags({ ...selections, reuseMarketplaces: true }).codex,
    ).toEqual({
      marketplaces: ['claude/source'],
      plugins: ['beta@codex'],
      removeMarketplaces: [],
      disablePlugins: ['codex-off'],
      uninstallPlugins: [],
    });
    expect(resolveFlags({ plugins: false })).toEqual({
      claude: emptyActions,
      codex: emptyActions,
    });
    expect(
      resolveFlags(pluginFlags({ claudePlugins: false, codexPlugins: false })),
    ).toEqual({ claude: emptyActions, codex: emptyActions });
  });

  it('should reject skips that conflict with explicit changes or inheritance', () => {
    const conflicts: CommandOptions[] = [
      pluginFlags({ plugins: false, claudePlugin: ['alpha@market'] }),
      pluginFlags({ plugins: false, codexPlugin: ['beta@market'] }),
      { plugins: false, reuseMarketplaces: true },
      pluginFlags({
        claudePlugins: false,
        claudeMarketplace: ['claude/source'],
      }),
      pluginFlags({ codexPlugins: false, codexPlugin: ['beta@market'] }),
      pluginFlags({
        reuseMarketplaces: true,
        claudeMarketplace: ['claude/source'],
        codexMarketplace: ['codex/source'],
      }),
    ];

    for (const options of conflicts) {
      expect(() => resolveFlags(options)).toThrow(
        expect.objectContaining({ code: 'USAGE' }),
      );
    }
  });

  it('should reuse the only marketplace-selecting harness for the others and refuse actions for an unselected harness', () => {
    const reuse = pluginFlags({
      reuseMarketplaces: true,
      codexMarketplace: ['codex/source'],
    });

    expect(resolveFlags(reuse).claude.marketplaces).toEqual(['codex/source']);
    expect(resolveFlags(reuse, ['codex']).claude).toEqual(emptyActions);
    expect(() =>
      resolveFlags(pluginFlags({ claudePlugin: ['alpha@market'] }), ['codex']),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
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
      hasExplicitFlags({}),
      hasExplicitFlags({ plugins: false }),
      hasExplicitFlags(pluginFlags({ claudePlugin: [] })),
      hasExplicitFlags(
        pluginFlags({ uninstallCodexPlugin: ['plugin@market'] }),
      ),
      hasExplicitFlags({ reuseMarketplaces: true }),
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
