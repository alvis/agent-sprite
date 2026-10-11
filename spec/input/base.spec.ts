import { describe, expect, it, vi } from 'vitest';

import { commandError } from '#errors';
import { resolveBaseInputs } from '#input/base';
import { redactResolved } from '#utilities/redaction';

describe('fn:resolveBaseInputs', () => {
  it('should retain a completed sibling secret when another Promise.all source rejects', async () => {
    const secret = 'saf08-partial-sibling-secret';
    const sources = {
      processEnv: { SPRITES_TOKEN: secret },
      fileEnv: {},
      profile: {},
    };

    await expect(
      resolveBaseInputs(
        {
          localCredentials: false,
          github: false,
          tailscaleApiKeySource: 'file:/nonexistent/saf08-secret-source',
        },
        sources,
      ),
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

  it('should resolve flag, process, dotenv, and profile precedence without forwarding credentials', async () => {
    const resolved = await resolveBaseInputs(
      {
        name: 'chosen',
        tailnet: 'flag-tailnet',
        localCredentials: false,
        env: 'selected.env',
      },
      {
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
          APP_TOKEN: 'runtime-secret-value',
        },
        profile: {
          TAILSCALE_TAILNET: 'profile-tailnet',
          TAILSCALE_EXIT_NODE: 'profile-exit',
          CLIPROXYAPI_BASE_URL: 'https://profile.example.test',
        },
      },
    );

    expect(resolved).toEqual({
      input: {
        name: 'chosen',
        spritesToken: 'process-management-token',
        tailscaleApiKey: 'process-tailnet-token',
        tailscaleAuthKey: undefined,
        tailnet: 'flag-tailnet',
        exitNode: 'file-exit',
        proxyUrl: 'https://process.example.test',
        proxyApiKey: undefined,
        integrations: { tailscale: false, exitNode: false, cliproxyapi: false },
        runtimeEnv: { APP_TOKEN: 'runtime-secret-value' },
        sources: {
          SPRITES_TOKEN: 'process environment',
          TAILSCALE_API_KEY: 'process environment',
          GH_TOKEN: 'process environment',
          TAILSCALE_TAILNET: 'flag',
          TAILSCALE_EXIT_NODE: 'selected.env',
          CLIPROXYAPI_BASE_URL: 'process environment',
        },
        missing: [],
      },
      githubCandidate: 'process-github-token',
    });
    expect(
      redactResolved(
        'process-management-token process-tailnet-token process-github-token runtime-secret-value',
      ),
    ).toBe('[REDACTED] [REDACTED] [REDACTED] [REDACTED]');
  });

  it('should select explicit secret references and record source descriptions without values', async () => {
    vi.stubEnv('AGENT_SPRITE_BASE_SPRITES', 'explicit-sprites-secret');
    vi.stubEnv('AGENT_SPRITE_BASE_TAILSCALE', 'explicit-tailscale-secret');
    vi.stubEnv('AGENT_SPRITE_BASE_PROXY', 'explicit-proxy-secret');
    vi.stubEnv('AGENT_SPRITE_BASE_GITHUB', 'explicit-github-secret');

    const resolved = await resolveBaseInputs(
      {
        localCredentials: false,
        spritesTokenSource: 'env:AGENT_SPRITE_BASE_SPRITES',
        tailscaleApiKeySource: 'env:AGENT_SPRITE_BASE_TAILSCALE',
        proxyApiKeySource: 'env:AGENT_SPRITE_BASE_PROXY',
        githubTokenSource: 'env:AGENT_SPRITE_BASE_GITHUB',
      },
      {
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
      { tailscale: true, exitNode: true, cliproxyapi: true },
    );

    expect(resolved).toEqual(
      expect.objectContaining({
        githubCandidate: 'explicit-github-secret',
        input: expect.objectContaining({
          spritesToken: 'explicit-sprites-secret',
          tailscaleApiKey: 'explicit-tailscale-secret',
          proxyApiKey: 'explicit-proxy-secret',
          tailscaleAuthKey: 'file-enrollment-secret',
          tailnet: 'file-tailnet',
          exitNode: 'profile-exit',
          proxyUrl: 'https://profile.example.test',
          integrations: { tailscale: true, exitNode: true, cliproxyapi: true },
          runtimeEnv: {},
          sources: {
            SPRITES_TOKEN: 'explicit secret reference',
            TAILSCALE_API_KEY: 'explicit secret reference',
            CLIPROXYAPI_API_KEY: 'explicit secret reference',
            GH_TOKEN: 'explicit secret reference',
            TAILSCALE_AUTH_KEY: 'env file',
            TAILSCALE_TAILNET: 'env file',
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

    const disabled = await resolveBaseInputs(
      { localCredentials: false, github: false },
      sources,
    );
    const selected = await resolveBaseInputs(
      { localCredentials: false },
      sources,
    );

    expect({
      disabled: disabled.githubCandidate,
      selected: selected.githubCandidate,
      sources: selected.input.sources,
    }).toEqual({
      disabled: undefined,
      selected: 'legacy-github-secret',
      sources: { GITHUB_TOKEN: 'env file' },
    });
  });
});
