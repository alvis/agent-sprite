import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  integrationRequirements,
  resolveCreateIntegrations,
  resolveSetupIntegrations,
} from '#input/integrations';

describe('fn:integrationRequirements', () => {
  it('should require credentials only for enabled integrations and omit enrollment for an existing identity', () => {
    const disabled = { tailscale: false, exitNode: false, cliproxyapi: false };
    const all = { tailscale: true, exitNode: true, cliproxyapi: true };

    expect([
      integrationRequirements(disabled),
      integrationRequirements(disabled, ['spritesToken']),
      integrationRequirements(all, ['spritesToken']),
      integrationRequirements({ ...all, exitNode: false }, [], true),
    ]).toEqual([
      [],
      ['spritesToken'],
      [
        'spritesToken',
        'tailscaleEnrollment',
        'tailnet',
        'exitNode',
        'proxyUrl',
        'proxyApiKey',
      ],
      ['tailnet', 'proxyUrl', 'proxyApiKey'],
    ]);
  });
});

describe('fn:resolveCreateIntegrations', () => {
  it('should infer direct inputs independently while explicit false wins', async () => {
    clearIntegrationEnvironment();
    const directory = await mkdtemp(
      join(tmpdir(), 'agent-sprite-integration-'),
    );
    vi.stubEnv('HOME', directory);

    try {
      const selections = await Promise.all([
        resolveCreateIntegrations({ nonInteractive: true }),
        resolveCreateIntegrations({ tailnet: 'chosen-tailnet' }),
        resolveCreateIntegrations({
          tailnet: 'chosen-tailnet',
          exitNode: 'chosen-exit',
          proxyUrl: 'https://proxy.example.test',
        }),
        resolveCreateIntegrations({
          tailscale: false,
          proxy: false,
          useExitNode: false,
          tailnet: 'chosen-tailnet',
          exitNode: 'chosen-exit',
          proxyUrl: 'https://proxy.example.test',
        }),
        resolveCreateIntegrations({ tailscale: false, useExitNode: true }),
      ]);

      expect(
        selections.map(({ integrations, problems }) => ({
          integrations,
          problems,
        })),
      ).toEqual([
        {
          integrations: {
            tailscale: false,
            exitNode: false,
            cliproxyapi: false,
          },
          problems: [],
        },
        {
          integrations: {
            tailscale: true,
            exitNode: false,
            cliproxyapi: false,
          },
          problems: [],
        },
        {
          integrations: { tailscale: true, exitNode: true, cliproxyapi: true },
          problems: [],
        },
        {
          integrations: {
            tailscale: false,
            exitNode: false,
            cliproxyapi: false,
          },
          problems: [],
        },
        {
          integrations: {
            tailscale: false,
            exitNode: true,
            cliproxyapi: false,
          },
          problems: [expect.any(String)],
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should use process boolean settings ahead of dotenv and honor explicit switches', async () => {
    clearIntegrationEnvironment();
    vi.stubEnv('TAILSCALE_ENABLED', 'off');
    vi.stubEnv('CLIPROXYAPI_ENABLED', 'ON');
    vi.stubEnv('TAILSCALE_EXIT_NODE_ENABLED', '0');
    const directory = await mkdtemp(join(tmpdir(), 'agent-sprite-choice-'));
    vi.stubEnv('HOME', directory);
    const path = join(directory, 'choice.env');
    await writeFile(
      path,
      'TAILSCALE_ENABLED=true\nCLIPROXYAPI_ENABLED=false\nTAILSCALE_EXIT_NODE_ENABLED=yes\n',
    );

    try {
      const selection = await resolveCreateIntegrations({ env: path });

      expect({
        integrations: selection.integrations,
        problems: selection.problems,
      }).toEqual({
        integrations: { tailscale: false, exitNode: false, cliproxyapi: true },
        problems: [],
      });
      await writeFile(path, 'TAILSCALE_ENABLED=not-a-boolean\n');
      await expect(
        resolveCreateIntegrations({ env: path, tailscale: true }),
      ).resolves.toEqual(
        expect.objectContaining({
          integrations: { tailscale: true, exitNode: false, cliproxyapi: true },
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should reject malformed enabled settings before resolving dependent inputs', async () => {
    clearIntegrationEnvironment();
    vi.stubEnv('TAILSCALE_ENABLED', 'not-a-boolean');
    const directory = await mkdtemp(
      join(tmpdir(), 'agent-sprite-invalid-choice-'),
    );
    vi.stubEnv('HOME', directory);

    try {
      await expect(resolveCreateIntegrations({})).rejects.toEqual(
        expect.objectContaining({ code: 'INPUT' }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('fn:resolveSetupIntegrations', () => {
  it('should preserve omitted installed selections and enable only a targeted integration', async () => {
    clearIntegrationEnvironment();
    const directory = await mkdtemp(
      join(tmpdir(), 'agent-sprite-setup-choice-'),
    );
    vi.stubEnv('HOME', directory);
    const installed = { tailscale: false, exitNode: false, cliproxyapi: false };

    try {
      const selections = await Promise.all([
        resolveSetupIntegrations({ options: {}, installed }),
        resolveSetupIntegrations({
          options: {},
          installed: { tailscale: true, exitNode: true, cliproxyapi: true },
        }),
        resolveSetupIntegrations({
          options: {},
          installed,
          selectedSection: 'tailscale',
        }),
        resolveSetupIntegrations({
          options: {},
          installed,
          selectedSection: 'proxy',
        }),
        resolveSetupIntegrations({
          options: { tailscale: false, proxy: false, useExitNode: false },
          installed: { tailscale: true, exitNode: true, cliproxyapi: true },
          selectedSection: 'all',
        }),
      ]);

      expect(selections).toEqual([
        installed,
        { tailscale: true, exitNode: true, cliproxyapi: true },
        { tailscale: true, exitNode: false, cliproxyapi: false },
        { tailscale: false, exitNode: false, cliproxyapi: true },
        installed,
      ]);
      await expect(
        resolveSetupIntegrations({
          options: { tailscale: false, useExitNode: true },
          installed,
          selectedSection: 'all',
        }),
      ).rejects.toEqual(expect.objectContaining({ code: 'INPUT' }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/** clears inherited integration choices before exercising caller input */
function clearIntegrationEnvironment(): void {
  for (const name of [
    'TAILSCALE_ENABLED',
    'TAILSCALE_EXIT_NODE_ENABLED',
    'CLIPROXYAPI_ENABLED',
    'TAILSCALE_TAILNET',
    'TAILSCALE_EXIT_NODE',
    'TAILSCALE_API_KEY',
    'TAILSCALE_AUTH_KEY',
    'CLIPROXYAPI_BASE_URL',
    'CLIPROXYAPI_API_KEY',
  ]) {
    vi.stubEnv(name, undefined);
  }
}
