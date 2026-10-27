import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { commandError } from '#application/failures';
import {
  requireValidProfile,
  requireValidSuppliedSelection,
  resolveCreateInputs,
  resolveInputs,
} from '#application/input';
import { resolveProviderCredential } from '#application/input/provider-credential';

import { DISABLED_NETWORK_PROFILE, profileWith } from '../fixtures/profile';
import { dependencies } from '../mocks/dependencies';

import type { Interaction } from '#application/ports/interaction';

describe('fn:requireValidProfile', () => {
  it('should return a valid resolved profile', () => {
    expect(
      requireValidProfile(
        dependencies,
        {
          candidate: DISABLED_NETWORK_PROFILE,
          problems: [],
          isIdleTimeoutRequested: false,
        },
        {},
      ),
    ).toEqual(DISABLED_NETWORK_PROFILE);
  });

  it('should report unreadable selection input and capability violations together', () => {
    let failure: unknown;
    try {
      requireValidProfile(
        dependencies,
        {
          candidate: { ...DISABLED_NETWORK_PROFILE, harnesses: [] },
          problems: ['OPEN_AGENT_IDLE_MINUTES must be a whole number'],
          isIdleTimeoutRequested: true,
        },
        {},
      );
    } catch (error) {
      failure = error;
    }

    expect(commandError(failure)).toMatchObject({
      code: 'INPUT',
      details: [
        'OPEN_AGENT_IDLE_MINUTES must be a whole number',
        expect.stringContaining('harness'),
      ],
    });
  });

  it('should report an unreadable input even when the resolved profile is valid', () => {
    let failure: unknown;
    try {
      requireValidProfile(
        dependencies,
        {
          candidate: DISABLED_NETWORK_PROFILE,
          problems: ['OPEN_AGENT_IDLE_MINUTES must be a whole number'],
          isIdleTimeoutRequested: false,
        },
        {},
      );
    } catch (error) {
      failure = error;
    }

    expect(commandError(failure)).toMatchObject({
      code: 'INPUT',
      details: ['OPEN_AGENT_IDLE_MINUTES must be a whole number'],
    });
  });
});

describe('fn:requireValidSuppliedSelection', () => {
  it('should accept a compatible supplied selection', () => {
    expect(() =>
      requireValidSuppliedSelection(
        dependencies,
        { value: { provider: 'sprite', options: {} }, problems: [] },
        {},
      ),
    ).not.toThrow();
  });

  it('should aggregate unreadable values and an unknown driver before workstation lookup', () => {
    let failure: unknown;
    try {
      requireValidSuppliedSelection(
        dependencies,
        {
          value: { agent: 'unregistered-agent', options: {} },
          problems: ['OPEN_AGENT_IDLE_MINUTES must be a whole number'],
        },
        {},
      );
    } catch (error) {
      failure = error;
    }

    expect(commandError(failure)).toMatchObject({
      code: 'INPUT',
      details: [
        'OPEN_AGENT_IDLE_MINUTES must be a whole number',
        expect.stringContaining('unregistered-agent'),
      ],
    });
  });
});

describe('fn:resolveInputs', () => {
  it('should aggregate all missing selection inputs, each naming every source, before account discovery', async () => {
    const input = await resolveInputs(dependencies, {
      options: {
        nonInteractive: true,
        localCredentials: false,
        github: false,
        gitIdentity: false,
      },
      requirementSelection: {
        sources: { processEnv: {}, fileEnv: {}, profile: {} },
        required: [
          'name',
          'providerToken',
          'networkEnrollment',
          'networkAccount',
          'exitNode',
          'proxyUrl',
          'proxyApiKey',
          'gitIdentity',
        ],
        profile: profileWith({
          network: true,
          exitNode: true,
          cliproxyapi: true,
        }),
      },
    });
    const defaults = await resolveInputs(dependencies, {
      options: {
        nonInteractive: true,
        localCredentials: false,
        github: false,
        gitIdentity: false,
      },
      requirementSelection: {
        sources: { processEnv: {}, fileEnv: {}, profile: {} },
      },
    });

    expect([input.missing, defaults.missing]).toEqual([
      [
        expect.stringContaining('--name'),
        'Tailscale management API key is not set. Set TAILSCALE_API_KEY or pass --credential-file FILE containing TAILSCALE_API_KEY; ' +
          'use --network-key-source env:NAME, file:PATH, or keychain:SERVICE/ACCOUNT; or run in a TTY to enter it when prompted. ' +
          'Or set TAILSCALE_AUTH_KEY (--network-auth-key-source SOURCE) to enrol with a single-use key.',
        expect.stringMatching(
          /^Tailscale tailnet .* is not set\. Set TAILSCALE_TAILNET or pass --credential-file FILE containing TAILSCALE_TAILNET; use --network-account ACCOUNT;/u,
        ),
        expect.stringContaining(
          'Set TAILSCALE_EXIT_NODE or pass --credential-file FILE containing TAILSCALE_EXIT_NODE; use --exit-node NODE;',
        ),
        expect.stringContaining(
          'Set CLIPROXYAPI_BASE_URL or pass --credential-file FILE containing CLIPROXYAPI_BASE_URL; use --proxy-url URL;',
        ),
        expect.stringContaining(
          'Set CLIPROXYAPI_API_KEY or pass --credential-file FILE containing CLIPROXYAPI_API_KEY;',
        ),
      ],
      [expect.stringContaining('--name')],
    ]);
  });

  it('should report an invalid proxy URL without including embedded credentials', async () => {
    const input = await resolveInputs(dependencies, {
      options: {
        nonInteractive: true,
        localCredentials: false,
        github: false,
        gitIdentity: false,
        proxyUrl:
          'https://sensitive-user:sensitive-password@proxy.example.test',
      },
      requirementSelection: {
        sources: {
          processEnv: {},
          fileEnv: { CLIPROXYAPI_API_KEY: 'client-key' },
          profile: {},
        },
        required: ['proxyUrl', 'proxyApiKey'],
      },
    });

    expect(input.missing).toEqual([expect.stringContaining('CLIProxyAPI')]);
    expect(JSON.stringify(input.missing)).not.toMatch(
      /sensitive-user|sensitive-password/,
    );
  });

  it('should resolve independent author and committer identity without local credential discovery', async () => {
    const input = await resolveInputs(dependencies, {
      options: {
        nonInteractive: true,
        localCredentials: false,
        github: false,
        gitName: 'Flag Author',
        gitCommitterEmail: 'flag-committer@example.test',
      },
      requirementSelection: {
        sources: {
          processEnv: {
            GIT_AUTHOR_NAME: 'Process Author',
            GIT_AUTHOR_EMAIL: 'process-author@example.test',
            GIT_COMMITTER_NAME: 'Process Committer',
          },
          fileEnv: {
            GIT_AUTHOR_EMAIL: 'file-author@example.test',
            GIT_COMMITTER_NAME: 'File Committer',
            GIT_COMMITTER_EMAIL: 'file-committer@example.test',
          },
          profile: {},
        },
        required: ['gitIdentity'],
      },
    });

    expect({ identity: input.gitIdentity, missing: input.missing }).toEqual({
      identity: {
        authorName: 'Flag Author',
        authorEmail: 'file-author@example.test',
        committerName: 'File Committer',
        committerEmail: 'flag-committer@example.test',
      },
      missing: [],
    });
  });

  it('should keep a known Git identity during a noninteractive run with an interaction attached', async () => {
    const unexpected = (): never => {
      throw new Error('A noninteractive run prompted for input');
    };
    const interaction: Interaction = {
      input: async () => unexpected(),
      secret: async () => unexpected(),
      select: async () => unexpected(),
      multiselect: async () => unexpected(),
      confirm: async () => unexpected(),
      progress: () => undefined,
      status: () => undefined,
    };
    const input = await resolveInputs(dependencies, {
      options: {
        nonInteractive: true,
        localCredentials: false,
        github: false,
        gitName: 'Known Author',
        gitEmail: 'known@example.test',
      },
      interaction,
      requirementSelection: {
        sources: { processEnv: {}, fileEnv: {}, profile: {} },
        required: ['gitIdentity'],
      },
    });

    expect(input.gitIdentity).toMatchObject({
      authorName: 'Known Author',
      authorEmail: 'known@example.test',
    });
    expect(input.missing).toEqual([]);
  });

  it('should include missing Git identity both before and after mandatory input resolution', async () => {
    vi.stubEnv('SPRITES_TOKEN', undefined);
    vi.stubEnv('GIT_AUTHOR_NAME', undefined);
    vi.stubEnv('GIT_AUTHOR_EMAIL', undefined);
    const directory = await mkdtemp(
      join(tmpdir(), 'open-agent-missing-identity-'),
    );
    vi.stubEnv('HOME', directory);
    const options = {
      nonInteractive: true,
      localCredentials: false,
      github: false,
    };

    try {
      const before = await resolveInputs(dependencies, {
        options,
        requirementSelection: {
          sources: { processEnv: {}, fileEnv: {}, profile: {} },
          required: ['providerToken', 'gitIdentity'],
        },
      });
      const after = await resolveInputs(dependencies, {
        options,
        requirementSelection: ['gitIdentity'],
      });
      const known = await resolveInputs(dependencies, {
        options: {
          ...options,
          gitName: 'Known Author',
          gitEmail: 'known@example.test',
        },
        requirementSelection: {
          sources: { processEnv: {}, fileEnv: {}, profile: {} },
          required: ['providerToken', 'gitIdentity'],
        },
      });
      const missingNameAndIdentity = await resolveInputs(dependencies, {
        options,
        requirementSelection: {
          sources: { processEnv: {}, fileEnv: {}, profile: {} },
          required: ['name', 'gitIdentity'],
        },
      });

      // the provider token is a declared provider prerequisite, reported by
      // the aggregated provider preflight rather than as a missing input
      expect([before.missing, after.missing, known.missing]).toEqual([
        [expect.stringContaining('Git author')],
        [expect.stringContaining('Git author')],
        [],
      ]);
      expect(missingNameAndIdentity.missing).toEqual([
        expect.stringContaining('--name'),
        expect.stringContaining('Git author'),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should derive create preflight requirements from the selected integrations', async () => {
    for (const name of [
      'SPRITES_TOKEN',
      'TAILSCALE_API_KEY',
      'TAILSCALE_AUTH_KEY',
      'TAILSCALE_TAILNET',
      'TAILSCALE_EXIT_NODE',
      'CLIPROXYAPI_BASE_URL',
      'CLIPROXYAPI_API_KEY',
    ]) {
      vi.stubEnv(name, undefined);
    }
    const directory = await mkdtemp(join(tmpdir(), 'open-agent-create-input-'));
    vi.stubEnv('HOME', directory);

    try {
      const selected = await resolveCreateInputs(dependencies, {
        network: 'tailscale',
        useExitNode: true,
        proxy: true,
        nonInteractive: true,
        localCredentials: false,
        github: false,
        gitIdentity: false,
      });

      expect({
        network: selected.profile.network,
        options: selected.profile.options,
        missing: selected.missing,
      }).toEqual({
        network: 'tailscale',
        options: expect.objectContaining({
          isExitNodeEnabled: true,
          isProxyEnabled: true,
        }),
        missing: [
          expect.stringContaining('--name'),
          expect.stringContaining('TAILSCALE_API_KEY'),
          expect.stringContaining('TAILSCALE_TAILNET'),
          expect.stringContaining('TAILSCALE_EXIT_NODE'),
          expect.stringContaining('CLIPROXYAPI_BASE_URL'),
          expect.stringContaining('CLIPROXYAPI_API_KEY'),
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should resolve a read-only provider token from the selected file or explicit reference', async () => {
    vi.stubEnv('SPRITES_TOKEN', undefined);
    const directory = await mkdtemp(
      join(tmpdir(), 'open-agent-provider-token-'),
    );
    vi.stubEnv('HOME', directory);
    const path = join(directory, 'chosen.env');
    const secretPath = join(directory, 'secret');
    await mkdir(join(directory, '.config', 'open-agent'), {
      recursive: true,
    });
    await writeFile(
      join(directory, '.config', 'open-agent', 'profile.json'),
      'malformed unrelated profile',
    );
    await writeFile(
      path,
      [
        'SPRITES_TOKEN=file-provider-secret',
        'GH_TOKEN=unused',
        'TAILSCALE_API_KEY=unused',
        '',
      ].join('\n'),
    );
    await writeFile(secretPath, 'explicit-provider-secret\n');

    try {
      const values = [
        await resolveProviderCredential(dependencies, {
          options: { credentialFile: path, localCredentials: false },
          provider: 'sprite',
        }),
        await resolveProviderCredential(dependencies, {
          options: { credentialFile: path, localCredentials: false },
          provider: 'sprite',
          selection: { reference: `file:${secretPath}` },
        }),
        await resolveProviderCredential(dependencies, {
          options: { localCredentials: false },
          provider: 'sprite',
        }),
      ];

      expect(values).toEqual([
        {
          token: 'file-provider-secret',
          source: `SPRITES_TOKEN in ${path}`,
        },
        {
          token: 'explicit-provider-secret',
          source: `--provider-token-source file:${secretPath}`,
        },
        {},
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should report an unavailable required GitHub token and defer account lookup while mandatory inputs are missing', async () => {
    const options = { nonInteractive: true, localCredentials: false };
    const absent = await resolveInputs(dependencies, {
      options,
      requirementSelection: {
        sources: { processEnv: {}, fileEnv: {}, profile: {} },
        required: ['githubToken'],
      },
    });
    const deferred = await resolveInputs(dependencies, {
      options,
      requirementSelection: {
        sources: {
          processEnv: { GH_TOKEN: 'unvalidated-account-candidate' },
          fileEnv: {},
          profile: {},
        },
        required: ['name', 'gitIdentity'],
      },
    });

    expect([
      { token: absent.githubToken, missing: absent.missing },
      { token: deferred.githubToken, missing: deferred.missing },
    ]).toEqual([
      { token: undefined, missing: [expect.stringContaining('GitHub token')] },
      { token: undefined, missing: [expect.stringContaining('--name')] },
    ]);
  });
});
