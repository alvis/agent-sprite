import { describe, expect, it } from 'vitest';

import {
  validateCommandRequest,
  validateSetupIntegrationOptions,
} from '#application/validation';

import type { CommandOptions, CommandRequest } from '#application/contracts';

describe('fn:validateCommandRequest', () => {
  it.each([
    { command: 'terminate', options: { nonInteractive: true } },
    {
      command: 'setup',
      options: {
        withPairCode: true,
        harnessPlugins: { claude: { plugins: ['one@market'] } },
      },
    },
  ] satisfies CommandRequest[])(
    'should reject a request whose required consent conflicts with its options: %j',
    (request) => {
      expect(() => validateCommandRequest(request)).toThrow(
        expect.objectContaining({ code: 'USAGE' }),
      );
    },
  );

  it('should infer the plugins section from actions while skip flags select no section', () => {
    expect(() =>
      validateCommandRequest({
        command: 'setup',
        options: {
          nonInteractive: true,
          harnessPlugins: { codex: { disablePlugins: ['one@market'] } },
        },
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
        options: {
          section: 'plugins',
          harnessPlugins: { claude: { isEnabled: false } },
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateCommandRequest({ command: 'create', options: {} }),
    ).not.toThrow();
  });

  it('should reject conflicting requests before credentials or remote access', () => {
    const conflicts: CommandOptions[] = [
      { gitIdentity: false, gitName: 'Author' },
      { gitIdentity: false, gitEmail: 'author@example.test' },
      { gitIdentity: false, gitCommitterName: 'Committer' },
      { gitIdentity: false, gitCommitterEmail: 'committer@example.test' },
      { github: false, githubTokenSource: 'env:TEST_GITHUB_TOKEN' },
      {
        localCredentials: false,
        providerTokenSource: 'keychain:test/account',
      },
      {
        plugins: false,
        harnessPlugins: { claude: { plugins: ['one@market'] } },
      },
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
      { pluginHarness: 'claude' },
      { harnessPlugins: { claude: { removeMarketplaces: ['old'] } } },
      { harnessPlugins: { codex: { removeMarketplaces: ['old'] } } },
      { harnessPlugins: { claude: { disablePlugins: ['off@market'] } } },
      { harnessPlugins: { codex: { disablePlugins: ['off@market'] } } },
      { harnessPlugins: { claude: { uninstallPlugins: ['gone@market'] } } },
      { harnessPlugins: { codex: { uninstallPlugins: ['gone@market'] } } },
    ];

    for (const options of setupOnly) {
      expect(() =>
        validateCommandRequest({ command: 'create', options }),
      ).toThrow(expect.objectContaining({ code: 'USAGE' }));
    }
    expect(() =>
      validateCommandRequest({
        command: 'setup',
        options: {
          section: 'git',
          harnessPlugins: { claude: { plugins: ['one@market'] } },
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() =>
      validateCommandRequest({
        command: 'setup',
        options: {
          section: 'plugins',
          pluginHarness: 'claude',
          harnessPlugins: { codex: { plugins: ['one@market'] } },
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() =>
      validateCommandRequest({
        command: 'setup',
        options: {
          section: 'plugins',
          pluginHarness: 'codex',
          harnessPlugins: { codex: { plugins: ['one@market'] } },
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateCommandRequest({ command: 'setup', options: {} }),
    ).not.toThrow();
  });

  it('should accept a non-interactive setup whose env or setup file selects its section', () => {
    expect(() =>
      validateCommandRequest({
        command: 'setup',
        options: { envFile: 'guest.env', nonInteractive: true },
      }),
    ).not.toThrow();
    expect(() =>
      validateCommandRequest({
        command: 'setup',
        options: { setupFile: 'system.sh', nonInteractive: true },
      }),
    ).not.toThrow();
    expect(() =>
      validateCommandRequest({
        command: 'setup',
        options: { nonInteractive: true },
      }),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
  });

  it('should refuse a pairing code for a non-pairing section', () => {
    expect(() =>
      validateCommandRequest({
        command: 'setup',
        options: { section: 'git', withPairCode: true },
      }),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
  });
});

describe('fn:validateSetupIntegrationOptions', () => {
  it('should allow network and option switches only in sections that apply them', () => {
    expect(() =>
      validateSetupIntegrationOptions(
        {
          network: 'tailscale',
          useExitNode: false,
          proxy: false,
          harness: ['claude'],
          idleMinutes: 0,
        },
        'all',
      ),
    ).not.toThrow();
    expect(() => validateSetupIntegrationOptions({}, undefined)).not.toThrow();
    expect(() =>
      validateSetupIntegrationOptions(
        { network: 'none', useExitNode: false },
        'network',
      ),
    ).not.toThrow();
    expect(() =>
      validateSetupIntegrationOptions({ proxy: false }, 'proxy'),
    ).not.toThrow();
    expect(() =>
      validateSetupIntegrationOptions({ network: 'none' }, 'proxy'),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() =>
      validateSetupIntegrationOptions({ useExitNode: false }, 'git'),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() =>
      validateSetupIntegrationOptions({ proxy: false }, 'network'),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() =>
      validateSetupIntegrationOptions({ idleMinutes: 30 }, 'network'),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
  });

  it.each([
    { release: 'latest' },
    { envFile: 'input.env' },
    { setupFile: 'setup.sh' },
  ] satisfies CommandOptions[])(
    'should refuse integration input outside the section that applies it: %j',
    (options) => {
      expect(() => validateSetupIntegrationOptions(options, 'git')).toThrow(
        expect.objectContaining({ code: 'USAGE' }),
      );
    },
  );

  it('should allow the update interval switch only in the tools section or the full setup', () => {
    const options = { updateDueDays: 3 };

    expect(() =>
      validateSetupIntegrationOptions(options, 'tools'),
    ).not.toThrow();
    expect(() => validateSetupIntegrationOptions(options, 'all')).not.toThrow();
    expect(() => validateSetupIntegrationOptions(options, 'git')).toThrow(
      expect.objectContaining({ code: 'USAGE' }),
    );
    expect(() =>
      validateSetupIntegrationOptions({ updateDueDays: 3 }, 'proxy'),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() =>
      validateSetupIntegrationOptions({ updateDueDays: 3 }, 'network'),
    ).toThrow(expect.objectContaining({ code: 'USAGE' }));
  });
});
