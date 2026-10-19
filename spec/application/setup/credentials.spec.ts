import { mkdtempDisposable, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { readLocalCredential } from '#adapters/host/credentials';
import { retainManagementCredential } from '#application/input/prompts';
import { setupLocalCredential } from '#application/setup/credentials';

import { driveInk } from '../../fixtures/ink';

import { dependencies } from '../../mocks/dependencies';

import type { CredentialStoreLocation } from '#domain/credentials';

describe('fn:setupLocalCredential consent', () => {
  it('should keep shared credentials unchanged when replacement is declined in real Ink', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-credential-decline-'),
    );
    vi.stubEnv('XDG_CONFIG_HOME', directory.path);
    const observed = await driveInk(
      async (interaction) =>
        setupLocalCredential(dependencies, { interaction, options: {} }),
      [
        {
          waitFor: 'Replace the saved Tailscale API key on this computer?',
          input: 'n',
        },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(1);
    expect(observed.result).toMatchObject({
      command: 'setup',
      ok: true,
      data: { localCredential: { status: 'unchanged' } },
    });
    expect(observed.result.data).not.toHaveProperty('machine');
  });

  it('should report the saved backend through real Ink and keeps both management credentials in one isolated store', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-local-save-'),
    );
    const location = {
      backend: 'protected-file',
      path: join(directory.path, 'vault', 'credentials.json'),
    } satisfies CredentialStoreLocation;
    const tailscaleSecret = 'generated-tailnet-management-secret';
    const spritesSecret = 'generated-sprites-management-secret';

    const observed = await driveInk(
      async (interaction) => {
        const setup = await setupLocalCredential(dependencies, {
          interaction,
          options: { yes: true },
          location,
        });
        const retained = await retainManagementCredential(dependencies, {
          name: 'sprites',
          value: spritesSecret,
          interaction,
          options: { yes: true },
          credentialStore: location,
        });

        return { setup, retained };
      },
      [
        {
          waitFor: 'New local Tailscale management API key',
          input: [tailscaleSecret, '\r'],
        },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(1);
    expect(observed.result).toMatchObject({
      setup: {
        command: 'setup',
        ok: true,
        data: {
          localCredential: { status: 'replaced', storage: 'protected-file' },
        },
      },
      retained: { storage: 'protected-file' },
    });
    expect(await readLocalCredential('tailscale', location)).toBe(
      tailscaleSecret,
    );
    expect(await readLocalCredential('sprites', location)).toBe(spritesSecret);
    expect((await stat(join(directory.path, 'vault'))).mode & 0o777).toBe(
      0o700,
    );
    expect((await stat(location.path)).mode & 0o777).toBe(0o600);
    expect(observed.output).not.toContain(tailscaleSecret);
    expect(observed.output).not.toContain(spritesSecret);
  });
});
