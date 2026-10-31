import { mkdtempDisposable, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { readLocalCredential } from '#adapters/host/credentials';
import { retainManagementCredential } from '#application/input/prompts';
import { setupLocalCredential } from '#application/setup/credentials';

import { driveInk } from '../../fixtures/ink';

import { dependencies } from '../../mocks/dependencies';

import type { Interaction } from '#application/ports/interaction';
import type { CredentialStoreLocation } from '#domain/credentials';

describe('fn:setupLocalCredential consent', () => {
  it('should reject replacement when no network declares management credentials', async () => {
    const tailscale = { ...dependencies.registry.networks.tailscale };
    delete tailscale.inputs;
    const registry = {
      ...dependencies.registry,
      networks: { none: dependencies.registry.networks.none, tailscale },
    };
    const interaction =
      {} satisfies Partial<Interaction> as Partial<Interaction> as Interaction;

    await expect(
      setupLocalCredential({ ...dependencies, registry }, { interaction }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('should replace only the selected network credential when several networks declare management inputs', async () => {
    const inputs = dependencies.registry.networks.tailscale.inputs!;
    const registry = {
      ...dependencies.registry,
      networks: {
        tailscale: dependencies.registry.networks.tailscale,
        none: {
          ...dependencies.registry.networks.none,
          inputs: {
            ...inputs,
            management: { ...inputs.management, store: 'sprites' as const },
          },
        },
      },
    } satisfies typeof dependencies.registry;
    const save = vi.fn<typeof dependencies.host.credentials.save>(async () => ({
      storage: 'protected-file',
    }));
    const host = {
      ...dependencies.host,
      credentials: { ...dependencies.host.credentials, save },
    };
    const interaction = {
      select: async (_prompt, choices) =>
        choices.find(({ value }) => value === 'none')!.value,
      secret: vi.fn<Interaction['secret']>(async () => 'synthetic-replacement'),
    } satisfies Partial<Interaction>;

    const result = await setupLocalCredential(
      { ...dependencies, registry, host },
      {
        interaction: interaction as Partial<Interaction> as Interaction,
        options: { yes: true },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        localCredential: { status: 'replaced', storage: 'protected-file' },
      },
    });
    expect(save.mock.calls).toEqual([
      [
        'sprites',
        'synthetic-replacement',
        {
          consent: true,
          allowProtectedFileFallback: true,
          location: undefined,
        },
      ],
    ]);
  });

  it('should reject replacement without an interactive secret prompt', async () => {
    await expect(setupLocalCredential(dependencies, {})).rejects.toMatchObject({
      code: 'USAGE',
    });
  });

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

  it.each([
    { yes: true, consent: [], matchedSteps: 1 },
    {
      yes: false,
      consent: [
        {
          waitFor: 'Replace the saved Tailscale API key on this computer?',
          input: 'y',
        },
      ],
      matchedSteps: 2,
    },
  ])(
    'should report the saved backend and isolate credentials with preapproved consent %s',
    async ({ yes, consent, matchedSteps }) => {
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
            options: { yes },
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
          ...consent,
          {
            waitFor: 'New local Tailscale management API key',
            input: [tailscaleSecret, '\r'],
          },
        ],
      );

      expect(observed.matchedSteps, observed.output).toBe(matchedSteps);
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
      expect(await readLocalCredential('sprites', location)).toBe(
        spritesSecret,
      );
      expect((await stat(join(directory.path, 'vault'))).mode & 0o777).toBe(
        0o700,
      );
      expect((await stat(location.path)).mode & 0o777).toBe(0o600);
      expect(observed.output).not.toContain(tailscaleSecret);
      expect(observed.output).not.toContain(spritesSecret);
    },
  );
});
