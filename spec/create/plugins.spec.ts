import { describe, expect, it } from 'vitest';

import { promptCreatePluginOptions } from '#create/plugins';

import { driveInk } from '../fixtures/ink.js';

describe('fn:promptCreatePluginOptions', () => {
  it('should not invent marketplace setup or cross-harness reuse under --yes', async () => {
    const selected = {
      yes: true,
      claudeMarketplace: ['selected-owner/selected-repo'],
    };
    const observed = await driveInk(
      async (interaction) => promptCreatePluginOptions(selected, interaction),
      [],
    );

    expect(observed.matchedSteps).toBe(0);
    expect(observed.result.claude.marketplaces).toEqual(
      selected.claudeMarketplace,
    );
    expect(observed.result.codex.marketplaces).toEqual([]);
    expect(observed.result.reuseClaudeMarketplaces).toBe(false);
    expect(observed.result.reuseClaudeMarketplacesSet).toBe(false);
  });

  it('should keep optional plugin choices interactive without --yes', async () => {
    const observed = await driveInk(
      async (interaction) => promptCreatePluginOptions({}, interaction),
      [
        { waitFor: 'Configure claude marketplaces or plugins', input: 'n' },
        { waitFor: 'Configure codex marketplaces or plugins', input: 'n' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(2);
    expect(observed.result.claude.marketplaces).toEqual([]);
    expect(observed.result.codex.marketplaces).toEqual([]);
    expect(observed.result.reuseClaudeMarketplacesSet).toBe(false);
  });

  it('should ask before reusing Claude sources for Codex without --yes', async () => {
    const observed = await driveInk(
      async (interaction) =>
        promptCreatePluginOptions(
          { claudeMarketplace: ['selected-owner/selected-repo'] },
          interaction,
        ),
      [
        { waitFor: 'Configure codex marketplaces or plugins', input: 'y' },
        {
          waitFor:
            'Use Claude marketplace sources as editable one-time Codex defaults?',
          input: 'n',
        },
        { waitFor: 'codex plugin choices', input: 'Done' },
        { waitFor: 'Search: Done', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(4);
    expect(observed.result.reuseClaudeMarketplaces).toBe(false);
    expect(observed.result.reuseClaudeMarketplacesSet).toBe(true);
    expect(observed.result.codex.marketplaces).toEqual([]);
  });
});
