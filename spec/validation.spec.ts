import { describe, expect, it } from 'vitest';

import {
  validateCommandRequest,
  validateSetupIntegrationOptions,
} from '#validation';

import type { CommandOptions } from '#command';

describe('fn:validateCommandRequest', () => {
  it('should infer the plugins section from actions while skip flags select no section', () => {
    expect(() =>
      validateCommandRequest({
        command: 'setup',
        options: { nonInteractive: true, disableCodexPlugin: ['one@market'] },
      }),
    ).not.toThrow();
    expect(() =>
      validateCommandRequest({
        command: 'setup',
        options: { nonInteractive: true, plugins: false },
      }),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() =>
      validateCommandRequest({
        command: 'setup',
        options: { section: 'plugins', claudePlugins: false },
      }),
    ).not.toThrow();
    expect(() =>
      validateCommandRequest({ command: 'create', options: {} }),
    ).not.toThrow();
  });

  it('should reject conflicting requests before credentials or remote access', () => {
    const conflicts: CommandOptions[] = [
      { tailscale: false, useExitNode: true },
      { gitIdentity: false, gitName: 'Author' },
      { gitIdentity: false, gitEmail: 'author@example.test' },
      { gitIdentity: false, gitCommitterName: 'Committer' },
      { gitIdentity: false, gitCommitterEmail: 'committer@example.test' },
      { github: false, githubTokenSource: 'env:TEST_GITHUB_TOKEN' },
      { localCredentials: false, spritesTokenSource: 'keychain:test/account' },
      { plugins: false, claudePlugin: ['one@market'] },
    ];

    for (const options of conflicts) {
      expect(() =>
        validateCommandRequest({ command: 'create', options }),
      ).toThrow(expect.objectContaining({ code: 'USAGE' }));
    }
  });

  it('should restrict removals to setup and enforce its selected section and harness', () => {
    const setupOnly: CommandOptions[] = [
      { section: 'plugins' },
      { harness: 'claude' },
      { removeClaudeMarketplace: ['old'] },
      { removeCodexMarketplace: ['old'] },
      { disableClaudePlugin: ['off@market'] },
      { disableCodexPlugin: ['off@market'] },
      { uninstallClaudePlugin: ['gone@market'] },
      { uninstallCodexPlugin: ['gone@market'] },
    ];

    for (const options of setupOnly) {
      expect(() =>
        validateCommandRequest({ command: 'create', options }),
      ).toThrow(expect.objectContaining({ code: 'USAGE' }));
    }
    expect(() =>
      validateCommandRequest({
        command: 'setup',
        options: { section: 'git', claudePlugin: ['one@market'] },
      }),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() =>
      validateCommandRequest({
        command: 'setup',
        options: {
          section: 'plugins',
          harness: 'claude',
          codexPlugin: ['one@market'],
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() =>
      validateCommandRequest({
        command: 'setup',
        options: {
          section: 'plugins',
          harness: 'codex',
          claudePlugin: ['one@market'],
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() =>
      validateCommandRequest({
        command: 'setup',
        options: {
          section: 'plugins',
          harness: 'codex',
          codexPlugin: ['one@market'],
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateCommandRequest({ command: 'setup', options: {} }),
    ).not.toThrow();
  });
});

describe('fn:validateSetupIntegrationOptions', () => {
  it('should allow integration switches only in sections that apply them', () => {
    expect(() =>
      validateSetupIntegrationOptions(
        { tailscale: true, useExitNode: false, proxy: false },
        'all',
      ),
    ).not.toThrow();
    expect(() => validateSetupIntegrationOptions({}, undefined)).not.toThrow();
    expect(() =>
      validateSetupIntegrationOptions(
        { tailscale: false, useExitNode: false },
        'tailscale',
      ),
    ).not.toThrow();
    expect(() =>
      validateSetupIntegrationOptions({ proxy: false }, 'proxy'),
    ).not.toThrow();
    expect(() =>
      validateSetupIntegrationOptions({ tailscale: false }, 'proxy'),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() =>
      validateSetupIntegrationOptions({ useExitNode: false }, 'git'),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() =>
      validateSetupIntegrationOptions({ proxy: false }, 'tailscale'),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
  });
});
