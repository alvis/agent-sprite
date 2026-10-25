import { describe, expect, it, vi } from 'vitest';

import { commandError } from '#application/failures';
import { resolveBaseInputs } from '#application/input/base';

import { redactResolved } from '#kernel/redaction';

import { profileWith } from '../../fixtures/profile';

import { dependencies } from '../../mocks/dependencies';

const networkOnly = profileWith({
  network: true,
  exitNode: false,
  cliproxyapi: false,
});
const everything = profileWith({
  network: true,
  exitNode: true,
  cliproxyapi: true,
});

describe('fn:resolveBaseInputs', () => {
  it('should retain a completed sibling secret when another Promise.all source rejects', async () => {
    const secret = 'saf08-partial-sibling-secret';
    const sources = {
      processEnv: { SPRITES_TOKEN: secret },
      fileEnv: {},
      profile: {},
    };

    await expect(
      resolveBaseInputs(dependencies, {
        options: {
          localCredentials: false,
          github: false,
          networkKeySource: 'file:/nonexistent/saf08-secret-source',
        },
        sources,
        selection: { profile: networkOnly },
      }),
    ).rejects.toMatchObject({ code: 'INPUT' });
    expect(redactResolved(`provider rejected ${secret}`)).toBe(
      'provider rejected [REDACTED]',
    );
    expect(
      commandError(new Error(`provider rejected ${secret}`)),
    ).toMatchObject({
      message: 'provider rejected [REDACTED]',
    });
  });

  it('should resolve flag, credential file, process, and profile precedence and forward only the guest env file', async () => {
    const resolved = await resolveBaseInputs(dependencies, {
      options: {
        name: 'chosen',
        networkAccount: 'flag-tailnet',
        localCredentials: false,
        credentialFile: 'selected.env',
      },
      sources: {
        processEnv: {
          SPRITES_TOKEN: 'process-management-token',
          TAILSCALE_API_KEY: 'process-tailnet-token',
          CLIPROXYAPI_BASE_URL: 'https://process.example.test',
          GH_TOKEN: 'process-github-token',
        },
        fileEnv: {
          SPRITES_TOKEN: 'file-management-token',
          TAILSCALE_EXIT_NODE: 'file-exit',
          CLIPROXYAPI_BASE_URL: 'https://file.example.test',
          CREDENTIAL_ONLY: 'credential-file-value',
        },
        runtimeFileEnv: { APP_TOKEN: 'runtime-secret-value' },
        profile: {
          TAILSCALE_TAILNET: 'profile-tailnet',
          TAILSCALE_EXIT_NODE: 'profile-exit',
          CLIPROXYAPI_BASE_URL: 'https://profile.example.test',
        },
      },
      selection: { profile: networkOnly },
    });

    expect(resolved).toEqual({
      input: {
        name: 'chosen',
        providerToken: 'file-management-token',
        networkKey: 'process-tailnet-token',
        enrollmentKey: undefined,
        networkAccount: 'flag-tailnet',
        exitNode: 'file-exit',
        proxyUrl: 'https://file.example.test',
        proxyApiKey: undefined,
        profile: networkOnly,
        runtimeEnv: { APP_TOKEN: 'runtime-secret-value' },
        sources: {
          SPRITES_TOKEN: 'SPRITES_TOKEN in selected.env',
          TAILSCALE_API_KEY: 'process environment',
          GH_TOKEN: 'process environment',
          TAILSCALE_TAILNET: 'flag',
          TAILSCALE_EXIT_NODE: 'selected.env',
          CLIPROXYAPI_BASE_URL: 'selected.env',
        },
        missing: [],
      },
      githubCandidate: 'process-github-token',
    });
    expect(
      redactResolved(
        'file-management-token process-tailnet-token process-github-token runtime-secret-value',
      ),
    ).toBe('[REDACTED] [REDACTED] [REDACTED] [REDACTED]');
  });

  it('should select explicit secret references and record source descriptions without values', async () => {
    vi.stubEnv('OPEN_AGENT_BASE_SPRITES', 'explicit-sprites-secret');
    vi.stubEnv('OPEN_AGENT_BASE_TAILSCALE', 'explicit-tailscale-secret');
    vi.stubEnv('OPEN_AGENT_BASE_PROXY', 'explicit-proxy-secret');
    vi.stubEnv('OPEN_AGENT_BASE_GITHUB', 'explicit-github-secret');

    const resolved = await resolveBaseInputs(dependencies, {
      options: {
        localCredentials: false,
        providerTokenSource: 'env:OPEN_AGENT_BASE_SPRITES',
        networkKeySource: 'env:OPEN_AGENT_BASE_TAILSCALE',
        proxyApiKeySource: 'env:OPEN_AGENT_BASE_PROXY',
        githubTokenSource: 'env:OPEN_AGENT_BASE_GITHUB',
      },
      sources: {
        processEnv: {},
        fileEnv: {
          TAILSCALE_AUTH_KEY: 'file-enrollment-secret',
          TAILSCALE_TAILNET: 'file-tailnet',
        },
        profile: {
          TAILSCALE_EXIT_NODE: 'profile-exit',
          CLIPROXYAPI_BASE_URL: 'https://profile.example.test',
        },
      },
      selection: { profile: everything },
    });

    expect(resolved).toEqual(
      expect.objectContaining({
        githubCandidate: 'explicit-github-secret',
        input: expect.objectContaining({
          providerToken: 'explicit-sprites-secret',
          networkKey: 'explicit-tailscale-secret',
          proxyApiKey: 'explicit-proxy-secret',
          enrollmentKey: 'file-enrollment-secret',
          networkAccount: 'file-tailnet',
          exitNode: 'profile-exit',
          proxyUrl: 'https://profile.example.test',
          runtimeEnv: {},
          sources: {
            SPRITES_TOKEN:
              '--provider-token-source env:OPEN_AGENT_BASE_SPRITES',
            TAILSCALE_API_KEY: 'explicit secret reference',
            CLIPROXYAPI_API_KEY: 'explicit secret reference',
            GH_TOKEN: 'explicit secret reference',
            TAILSCALE_AUTH_KEY: 'credential file',
            TAILSCALE_TAILNET: 'credential file',
            TAILSCALE_EXIT_NODE: 'saved profile',
            CLIPROXYAPI_BASE_URL: 'saved profile',
          },
        }),
      }),
    );
    expect(
      redactResolved(
        'explicit-sprites-secret explicit-tailscale-secret explicit-proxy-secret explicit-github-secret file-enrollment-secret',
      ),
    ).toBe('[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]');
  });

  it('should leave GitHub discovery disabled when requested and use its legacy token fallback otherwise', async () => {
    const sources = {
      processEnv: {},
      fileEnv: { GITHUB_TOKEN: 'legacy-github-secret' },
      profile: {},
    };

    const disabled = await resolveBaseInputs(dependencies, {
      options: { localCredentials: false, github: false },
      sources,
    });
    const selected = await resolveBaseInputs(dependencies, {
      options: { localCredentials: false },
      sources,
    });

    expect({
      disabled: disabled.githubCandidate,
      selected: selected.githubCandidate,
      sources: selected.input.sources,
    }).toEqual({
      disabled: undefined,
      selected: 'legacy-github-secret',
      sources: { GITHUB_TOKEN: 'credential file' },
    });
  });
});
