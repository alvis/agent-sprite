import { describe, expect, it } from 'vitest';

import {
  describePluginSelections,
  promptCreatePluginOptions,
} from '#application/create/plugins';

import {
  normalizePluginOptions,
  resolvePluginActions,
} from '#application/plugins';

import { driveInk } from '../../fixtures/ink';
import { pluginFlags } from '../../fixtures/plugin-flags';

describe('fn:promptCreatePluginOptions', () => {
  it('should add independent native choices and preserve them when an input goes back', async () => {
    const observed = await driveInk(
      async (interaction) =>
        promptCreatePluginOptions({}, ['claude'], interaction),
      [
        { waitFor: 'Configure Claude marketplaces or plugins', input: 'y' },
        { waitFor: 'Claude plugin choices', input: '\r' },
        { waitFor: 'Claude marketplace source/ref', input: 'owner/source' },
        { waitFor: 'owner/source', input: '\r' },
        { waitFor: 'Claude plugin choices', input: 'Install' },
        { waitFor: 'Search: Install', input: '\r' },
        { waitFor: 'Claude native plugin identity', input: 'selected@market' },
        { waitFor: 'selected@market', input: '\r' },
        { waitFor: 'Claude plugin choices', input: '\r' },
        { waitFor: 'Claude marketplace source/ref', input: '\u001b' },
        { waitFor: 'Claude plugin choices', input: 'Done' },
        { waitFor: 'Search: Done', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(12);
    expect(observed.result.harnesses.claude).toMatchObject({
      marketplaces: ['owner/source'],
      plugins: ['selected@market'],
    });
  });

  it('should replace accepted inherited marketplaces with the harness own source', async () => {
    const observed = await driveInk(
      async (interaction) =>
        promptCreatePluginOptions(
          pluginFlags({ claudeMarketplace: ['owner/claude'] }),
          ['claude', 'codex'],
          interaction,
        ),
      [
        { waitFor: 'Configure Codex marketplaces or plugins', input: 'y' },
        { waitFor: 'Use Claude marketplace sources', input: 'y' },
        { waitFor: 'Codex plugin choices', input: '\r' },
        { waitFor: 'Codex marketplace source/ref', input: 'owner/codex' },
        { waitFor: 'owner/codex', input: '\r' },
        { waitFor: 'Codex plugin choices', input: 'Done' },
        { waitFor: 'Search: Done', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(7);
    expect(observed.result).toMatchObject({
      reuseMarketplaces: false,
      reuseMarketplacesSet: true,
      harnesses: {
        claude: { marketplaces: ['owner/claude'] },
        codex: { marketplaces: ['owner/codex'] },
      },
    });
  });

  it('should accept explicit inherited defaults without prompting the inheriting harness', async () => {
    const observed = await driveInk(
      async (interaction) =>
        promptCreatePluginOptions(
          pluginFlags({
            reuseMarketplaces: true,
            claudeMarketplace: ['owner/source'],
          }),
          ['claude', 'codex'],
          interaction,
        ),
      [],
    );

    expect(observed.matchedSteps).toBe(0);
    expect(observed.result).toMatchObject({
      reuseMarketplaces: true,
      reuseMarketplacesSet: true,
      harnesses: {
        claude: { marketplaces: ['owner/source'] },
        codex: { marketplaces: [] },
      },
    });
  });

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

describe('fn:describePluginSelections', () => {
  it('should show absent and selected native actions independently', () => {
    const plugins = resolvePluginActions(
      normalizePluginOptions({
        harnessPlugins: {
          claude: {
            marketplaces: ['owner/source'],
            plugins: ['plugin@market'],
          },
        },
      }),
    );

    expect(describePluginSelections(plugins, ['claude', 'codex'])).toEqual([
      expect.stringMatching(/Claude.*owner\/source.*plugin@market/),
      expect.stringMatching(/Codex.*none.*none/),
    ]);
  });
});
