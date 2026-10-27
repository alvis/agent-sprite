import { describe, expect, it } from 'vitest';

import {
  harnessPluginOptions,
  harnessPluginToggleNames,
} from '#cli/harness-flags';

describe('fn:harnessPluginOptions', () => {
  it('should omit harnesses whose flags were not supplied', () => {
    expect(harnessPluginOptions({})).toEqual({});
  });

  it('should retain explicit false and empty selections for one harness', () => {
    expect(
      harnessPluginOptions({
        claudePlugins: false,
        claudeMarketplace: [],
      }),
    ).toEqual({
      claude: expect.objectContaining({
        isEnabled: false,
        marketplaces: [],
      }),
    });
  });

  it('should keep selections and setup changes scoped to their harness', () => {
    const options = harnessPluginOptions({
      claudeMarketplace: ['first', 'second'],
      claudePlugin: ['alpha'],
      removeClaudeMarketplace: ['old'],
      disableClaudePlugin: ['disabled'],
      uninstallClaudePlugin: ['retired'],
      codexPlugins: true,
      codexMarketplace: ['codex-source'],
    });

    expect(options).toEqual({
      claude: {
        isEnabled: undefined,
        marketplaces: ['first', 'second'],
        plugins: ['alpha'],
        removeMarketplaces: ['old'],
        disablePlugins: ['disabled'],
        uninstallPlugins: ['retired'],
      },
      codex: {
        isEnabled: true,
        marketplaces: ['codex-source'],
        plugins: undefined,
        removeMarketplaces: undefined,
        disablePlugins: undefined,
        uninstallPlugins: undefined,
      },
    });
  });
});

describe('fn:harnessPluginToggleNames', () => {
  it('should expose the supported negatable plugin toggles', () => {
    expect(harnessPluginToggleNames()).toEqual([
      'claude-plugins',
      'codex-plugins',
    ]);
  });
});
