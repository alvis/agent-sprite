import { describe, expect, it } from 'vitest';

import { promptCreatePluginOptions } from '#create/plugins';

import { driveInk } from '../fixtures/ink.js';
import { pluginFlags } from '../fixtures/plugin-flags.js';

describe('fn:promptCreatePluginOptions', () => {
  it('should not invent marketplace setup or cross-harness reuse under --yes', async () => {
    const sources = ['selected-owner/selected-repo'];
    const selected = pluginFlags({ yes: true, claudeMarketplace: sources });
    const observed = await driveInk(
      async (interaction) =>
        promptCreatePluginOptions(selected, ['claude', 'codex'], interaction),
      [],
    );

    expect(observed.matchedSteps).toBe(0);
    expect(observed.result.harnesses.claude.marketplaces).toEqual(sources);
    expect(observed.result.harnesses.codex.marketplaces).toEqual([]);
    expect(observed.result.reuseMarketplaces).toBe(false);
    expect(observed.result.reuseMarketplacesSet).toBe(false);
  });

  it('should keep optional plugin choices interactive without --yes', async () => {
    const observed = await driveInk(
      async (interaction) =>
        promptCreatePluginOptions({}, ['claude', 'codex'], interaction),
      [
        { waitFor: 'Configure Claude marketplaces or plugins', input: 'n' },
        { waitFor: 'Configure Codex marketplaces or plugins', input: 'n' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(2);
    expect(observed.result.harnesses.claude.marketplaces).toEqual([]);
    expect(observed.result.harnesses.codex.marketplaces).toEqual([]);
    expect(observed.result.reuseMarketplacesSet).toBe(false);
  });

  it('should ask before reusing Claude sources for Codex without --yes', async () => {
    const observed = await driveInk(
      async (interaction) =>
        promptCreatePluginOptions(
          pluginFlags({ claudeMarketplace: ['selected-owner/selected-repo'] }),
          ['claude', 'codex'],
          interaction,
        ),
      [
        { waitFor: 'Configure Codex marketplaces or plugins', input: 'y' },
        {
          waitFor:
            'Use Claude marketplace sources as editable one-time Codex defaults?',
          input: 'n',
        },
        { waitFor: 'Codex plugin choices', input: 'Done' },
        { waitFor: 'Search: Done', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(4);
    expect(observed.result.reuseMarketplaces).toBe(false);
    expect(observed.result.reuseMarketplacesSet).toBe(true);
    expect(observed.result.harnesses.codex.marketplaces).toEqual([]);
  });
});
