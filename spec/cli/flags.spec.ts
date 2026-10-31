import { buildApplication, buildCommand, run } from '@stricli/core';
import { describe, expect, it } from 'vitest';

import {
  normalizePluginOptions,
  resolvePluginActions,
} from '#application/plugins';
import {
  commonFlags,
  consentFlags,
  integrationCredentialFlags,
  integrationFlags,
  networkCredentialFlags,
  pairingFlags,
  pluginFlags,
  selectionFlags,
  setupFlags,
} from '#cli/flags';
import {
  harnessPluginChangeFlags,
  harnessPluginFlags,
  harnessPluginOptions,
} from '#cli/flags/harness';

import type { StricliProcess } from '@stricli/core';

import type { CommandOptions } from '#application/contracts';
import type { HarnessPluginActions } from '#application/plugins';
import type { HarnessPluginFlagValues } from '#cli/flags/harness';

type ParsedValues = CommandOptions & HarnessPluginFlagValues;

type ParserOptions = {
  [
    Key in keyof typeof parserFlags & keyof ParsedValues
  ]: (typeof parserFlags)[Key] extends {
    optional: true;
  }
    ? ParsedValues[Key]
    : NonNullable<ParsedValues[Key]>;
};

const parserFlags = {
  ...commonFlags,
  ...consentFlags,
  ...pairingFlags,
  ...selectionFlags,
  ...integrationFlags,
  ...networkCredentialFlags,
  ...integrationCredentialFlags,
  ...pluginFlags,
  ...harnessPluginFlags,
  ...harnessPluginChangeFlags,
  ...setupFlags,
};

describe('cmd:setup', () => {
  it.each([
    ['color', 'color'],
    ['local-credentials', 'localCredentials'],
    ['github', 'github'],
    ['git-identity', 'gitIdentity'],
    ['plugins', 'plugins'],
    ['claude-plugins', 'claudePlugins'],
    ['codex-plugins', 'codexPlugins'],
    ['proxy', 'proxy'],
    ['use-exit-node', 'useExitNode'],
  ] as const)(
    'should preserve omitted, positive and negative values for --%s',
    async (flag, property) => {
      const omitted = await parseFlags([]);
      const enabled = await parseFlags([`--${flag}`]);
      const disabled = await parseFlags([`--no-${flag}`]);

      expect(omitted.options[0]).toHaveProperty(property, undefined);
      expect(enabled.options[0]).toHaveProperty(property, true);
      expect(disabled.options[0]).toHaveProperty(property, false);
      expect([omitted.exitCode, enabled.exitCode, disabled.exitCode]).toEqual([
        0, 0, 0,
      ]);
      expect([
        omitted.diagnostics,
        enabled.diagnostics,
        disabled.diagnostics,
      ]).toEqual([[], [], []]);
    },
  );

  it('should accept only the positive explicit pairing request', async () => {
    const omitted = await parseFlags([]);
    const requested = await parseFlags(['--with-pair-code']);

    expect(omitted.options[0]).toHaveProperty('withPairCode', undefined);
    expect(requested.options[0]).toHaveProperty('withPairCode', true);
    expect(requested.exitCode).toBe(0);
  });

  it('should accumulate repeated plugin actions independently through Stricli', async () => {
    const parsed = await parseFlags([
      '--claude-marketplace',
      'claude/one',
      '--claude-marketplace',
      'claude/two',
      '--codex-marketplace',
      'codex/one',
      '--codex-marketplace',
      'codex/two',
      '--claude-plugin',
      'alpha@claude',
      '--claude-plugin',
      'beta@claude',
      '--codex-plugin',
      'alpha@codex',
      '--codex-plugin',
      'beta@codex',
      '--remove-claude-marketplace',
      'old-claude',
      '--remove-claude-marketplace',
      'older-claude',
      '--remove-codex-marketplace',
      'old-codex',
      '--remove-codex-marketplace',
      'older-codex',
      '--disable-claude-plugin',
      'off@claude',
      '--disable-claude-plugin',
      'off-again@claude',
      '--disable-codex-plugin',
      'off@codex',
      '--disable-codex-plugin',
      'off-again@codex',
      '--uninstall-claude-plugin',
      'gone@claude',
      '--uninstall-claude-plugin',
      'gone-again@claude',
      '--uninstall-codex-plugin',
      'gone@codex',
      '--uninstall-codex-plugin',
      'gone-again@codex',
    ]);

    expect(parsed).toEqual({
      actions: [
        {
          claude: {
            marketplaces: ['claude/one', 'claude/two'],
            plugins: ['alpha@claude', 'beta@claude'],
            removeMarketplaces: ['old-claude', 'older-claude'],
            disablePlugins: ['off@claude', 'off-again@claude'],
            uninstallPlugins: ['gone@claude', 'gone-again@claude'],
          },
          codex: {
            marketplaces: ['codex/one', 'codex/two'],
            plugins: ['alpha@codex', 'beta@codex'],
            removeMarketplaces: ['old-codex', 'older-codex'],
            disablePlugins: ['off@codex', 'off-again@codex'],
            uninstallPlugins: ['gone@codex', 'gone-again@codex'],
          },
        },
      ],
      options: [
        expect.objectContaining({
          network: undefined,
          proxy: undefined,
          useExitNode: undefined,
        }),
      ],
      diagnostics: [],
      exitCode: 0,
    });
  });

  it('should preserve explicit false values for independent integration switches', async () => {
    const parsed = await parseFlags([
      '--network',
      'none',
      '--proxy',
      '--no-use-exit-node',
      '--section',
      'all',
    ]);

    expect(parsed).toEqual(
      expect.objectContaining({
        options: [
          expect.objectContaining({
            network: 'none',
            proxy: true,
            useExitNode: false,
            section: 'all',
          }),
        ],
        diagnostics: [],
        exitCode: 0,
      }),
    );
  });

  it('should parse a signed whole-number minimum and reject fractional flag text', async () => {
    const accepted = await parseFlags(['--cpu', ' -2 ']);
    const rejected = await parseFlags(['--cpu', '1.5']);

    expect(accepted).toMatchObject({
      options: [expect.objectContaining({ cpu: -2 })],
      diagnostics: [],
      exitCode: 0,
    });
    expect(rejected).toMatchObject({
      options: [],
      diagnostics: expect.arrayContaining([
        expect.stringContaining('whole number'),
      ]),
    });
    expect(rejected.exitCode).not.toBe(0);
  });

  it('should accept stable releases and reject unknown release channels before invoking a command', async () => {
    const accepted = await parseFlags(['--release', 'stable']);
    const rejected = await parseFlags(['--release', 'relay']);

    expect(accepted).toMatchObject({
      options: [expect.objectContaining({ release: 'stable' })],
      diagnostics: [],
      exitCode: 0,
    });
    expect(rejected).toMatchObject({
      options: [],
      diagnostics: expect.arrayContaining([expect.stringContaining('relay')]),
    });
    expect(rejected.exitCode).not.toBe(0);
  });

  it('should reject unknown section values before a command handler runs', async () => {
    const parsed = await parseFlags(['--section', 'unsupported']);

    expect(parsed.actions).toEqual([]);
    expect(parsed.exitCode).not.toBe(0);
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
  });
});

/**
 * consumes production flags through the real Stricli scanner
 * @param argv command-line flags to parse
 * @returns parsed behavior and scanner diagnostics
 */
async function parseFlags(argv: string[]): Promise<{
  actions: HarnessPluginActions[];
  options: CommandOptions[];
  diagnostics: string[];
  exitCode: StricliProcess['exitCode'];
}> {
  const actions: HarnessPluginActions[] = [];
  const options: CommandOptions[] = [];
  const diagnostics: string[] = [];
  const parserProcess: StricliProcess = {
    stdout: {
      write: (text: string): void => {
        diagnostics.push(text);
      },
    },
    stderr: {
      write: (text: string): void => {
        diagnostics.push(text);
      },
    },
  };
  const context = { process: parserProcess };
  const application = buildApplication(
    buildCommand({
      parameters: {
        flags: parserFlags,
      },
      docs: { brief: 'parse workstation setup inputs' },
      func: (flags: ParserOptions): void => {
        const parsed = {
          ...flags,
          harnessPlugins: harnessPluginOptions(flags),
        };
        actions.push(resolvePluginActions(normalizePluginOptions(parsed)));
        options.push(parsed);
      },
    }),
    { name: 'open-agent', scanner: { caseStyle: 'allow-kebab-for-camel' } },
  );

  await run(application, argv, context);

  return { actions, options, diagnostics, exitCode: parserProcess.exitCode };
}
