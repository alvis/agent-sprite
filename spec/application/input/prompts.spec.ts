import { describe, expect, it, vi } from 'vitest';

import { commandError } from '#application/failures';
import {
  resolveInteractiveInputs,
  retainEnteredProviderToken,
  retainManagementCredential,
} from '#application/input/prompts';

import { driveInk } from '../../fixtures/ink';
import { DISABLED_NETWORK_PROFILE, profileWith } from '../../fixtures/profile';

import { dependencies, dependenciesWith } from '../../mocks/dependencies';

import type { ResolvedInputs } from '#application/input/types';
import type { Interaction } from '#application/ports/interaction';

/** fresh local input state without provider or credential-store access */
function emptyInput(): ResolvedInputs {
  return {
    profile: DISABLED_NETWORK_PROFILE,
    runtimeEnv: {},
    sources: {},
    missing: [],
  };
}

/**
 * an interaction that records consent and status without terminal rendering
 * @param consent whether the user accepts local retention
 */
function credentialInteraction(consent: boolean): {
  interaction: Interaction;
  confirm: ReturnType<typeof vi.fn<Interaction['confirm']>>;
  status: ReturnType<typeof vi.fn<Interaction['status']>>;
} {
  const confirm = vi.fn<Interaction['confirm']>(async () => consent);
  const status = vi.fn<Interaction['status']>();

  return {
    interaction: {
      input: async () => '',
      secret: async () => '',
      select: async () => {
        throw new Error('Unexpected selection');
      },
      multiselect: async () => {
        throw new Error('Unexpected multiple selection');
      },
      confirm,
      progress: () => undefined,
      status,
    },
    confirm,
    status,
  };
}

describe('fn:retainManagementCredential', () => {
  it('should honor declined consent without writing a credential', async () => {
    const save = vi.fn<typeof dependencies.host.credentials.save>();
    const { interaction, confirm } = credentialInteraction(false);
    const result = await retainManagementCredential(
      dependenciesWith({
        host: {
          ...dependencies.host,
          credentials: { ...dependencies.host.credentials, save },
        },
      }),
      {
        name: 'tailscale',
        value: 'management-key',
        interaction,
        options: {},
      },
    );

    expect(result).toBeUndefined();
    expect(confirm).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });

  it('should save with explicit consent and report a protected-file fallback', async () => {
    const save = vi.fn<typeof dependencies.host.credentials.save>(async () => ({
      storage: 'protected-file',
      fallbackReason: 'Keychain is unavailable on this platform',
    }));
    const { interaction, confirm, status } = credentialInteraction(false);
    const location = {
      backend: 'protected-file' as const,
      path: '/var/secure/credential-store',
    };
    const result = await retainManagementCredential(
      dependenciesWith({
        host: {
          ...dependencies.host,
          credentials: { ...dependencies.host.credentials, save },
        },
      }),
      {
        name: 'tailscale',
        value: 'management-key',
        interaction,
        options: { yes: true },
        credentialStore: location,
      },
    );

    expect(result).toEqual({
      storage: 'protected-file',
      fallbackReason: 'Keychain is unavailable on this platform',
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith('tailscale', 'management-key', {
      consent: true,
      allowProtectedFileFallback: true,
      location,
    });
    expect(status).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'warning' }),
    );
  });
});

describe('fn:retainEnteredProviderToken', () => {
  it('should retain an accepted entered token once and record its storage backend', async () => {
    const save = vi.fn<typeof dependencies.host.credentials.save>(async () => ({
      storage: 'keychain',
    }));
    const configured = dependenciesWith({
      host: {
        ...dependencies.host,
        credentials: { ...dependencies.host.credentials, save },
      },
    });
    const input = emptyInput();
    input.providerToken = 'provider-token';
    input.isProviderTokenEntered = true;
    const { interaction, confirm, status } = credentialInteraction(true);

    await retainEnteredProviderToken(configured, input, {
      interaction,
      options: {},
    });
    await retainEnteredProviderToken(configured, input, {
      interaction,
      options: {},
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'success' }),
    );
    expect(input.retainedCredentials).toEqual({
      sprites: { storage: 'keychain' },
    });
    expect(input.isProviderTokenEntered).toBe(false);
  });

  it('should clear the entered-token marker after declining storage', async () => {
    const save = vi.fn<typeof dependencies.host.credentials.save>();
    const input = emptyInput();
    input.providerToken = 'provider-token';
    input.isProviderTokenEntered = true;
    const { interaction } = credentialInteraction(false);

    await retainEnteredProviderToken(
      dependenciesWith({
        host: {
          ...dependencies.host,
          credentials: { ...dependencies.host.credentials, save },
        },
      }),
      input,
      { interaction, options: {} },
    );

    expect(save).not.toHaveBeenCalled();
    expect(input.retainedCredentials).toBeUndefined();
    expect(input.isProviderTokenEntered).toBe(false);
  });

  it('should defer retention when there is no interactive consent', async () => {
    const input = emptyInput();
    input.providerToken = 'provider-token';
    input.isProviderTokenEntered = true;

    await retainEnteredProviderToken(dependencies, input, { options: {} });
    await retainEnteredProviderToken(dependencies, input, {
      interaction: credentialInteraction(true).interaction,
      options: { nonInteractive: true },
    });

    expect(input.isProviderTokenEntered).toBe(true);
    expect(input.retainedCredentials).toBeUndefined();
  });
});

describe('fn:resolveInteractiveInputs', () => {
  it('should leave unresolved inputs untouched without an interactive prompt boundary', async () => {
    const input = emptyInput();
    const { interaction } = credentialInteraction(true);

    await resolveInteractiveInputs(dependencies, input, {
      options: {},
      required: ['name'],
    });
    await resolveInteractiveInputs(dependencies, input, {
      options: { nonInteractive: true },
      interaction,
      required: ['name'],
    });

    expect(input.name).toBeUndefined();
  });
  it('should collect the selected network, gateway, and secret inputs in dependency order', async () => {
    const input = emptyInput();
    input.profile = profileWith({
      network: true,
      exitNode: true,
      cliproxyapi: true,
    });
    const asked: string[] = [];
    const nameChecks: Array<string | undefined> = [];
    const interaction: Interaction = {
      input: async ({ message, validate }) => {
        asked.push(message);
        if (message === 'Workstation name') {
          nameChecks.push(validate?.('Bad_Name'), validate?.('valid-name'));

          return 'valid-name';
        }
        if (message.includes('tailnet')) {
          return 'example-tailnet';
        }
        if (message.includes('exit node')) {
          return 'exit-node';
        }

        return 'https://proxy.example.test';
      },
      secret: async ({ message, validate }) => {
        asked.push(message);
        if (message.includes('Sprites')) {
          expect(validate?.('provider-token')).toBeUndefined();

          return 'provider-token';
        }

        return message.includes('Tailscale') ? 'network-key' : 'proxy-key';
      },
      select: async () => {
        throw new Error('Unexpected choice prompt');
      },
      multiselect: async () => {
        throw new Error('Unexpected multiple-choice prompt');
      },
      confirm: async () => false,
      progress: () => undefined,
      status: () => undefined,
    };

    await resolveInteractiveInputs(dependencies, input, {
      options: { localCredentials: false },
      interaction,
      required: [
        'name',
        'networkAccount',
        'exitNode',
        'proxyUrl',
        'providerToken',
        'networkEnrollment',
        'proxyApiKey',
      ],
    });

    expect(nameChecks).toEqual([
      expect.stringContaining('lowercase DNS label'),
      undefined,
    ]);
    expect(asked).toHaveLength(7);
    expect(input).toMatchObject({
      name: 'valid-name',
      networkAccount: 'example-tailnet',
      exitNode: 'exit-node',
      proxyUrl: 'https://proxy.example.test',
      providerToken: 'provider-token',
      networkKey: 'network-key',
      proxyApiKey: 'proxy-key',
      isProviderTokenEntered: true,
    });
  });
  it('should keep an invalid workstation name in the real Ink input prompt', async () => {
    const input = emptyInput();
    const observed = await driveInk(
      async (interaction) => {
        try {
          await resolveInteractiveInputs(dependencies, input, {
            options: { localCredentials: false },
            interaction,
            required: ['name'],
          });
        } catch (error) {
          return commandError(error);
        }

        throw new Error('The invalid name was unexpectedly accepted');
      },
      [
        { waitFor: 'Workstation name', input: 'Bad_Name' },
        { waitFor: 'Bad_Name', input: '\r' },
        { waitFor: 'lowercase DNS label', input: '\x03' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(3);
    expect(observed.result.code).toBe('CANCELLED');
    expect(input.name).toBeUndefined();
  });

  it('should edit a rejected name and accepts its replacement in the same Ink prompt', async () => {
    const input = emptyInput();
    const observed = await driveInk(
      async (interaction) => {
        await resolveInteractiveInputs(dependencies, input, {
          options: { localCredentials: false },
          interaction,
          required: ['name'],
        });

        return input.name;
      },
      [
        { waitFor: 'Workstation name', input: 'Bad_Name' },
        { waitFor: 'Workstation name: Bad_Name', input: '\r' },
        { waitFor: 'lowercase DNS label', input: '\x7f' },
        { waitFor: 'Workstation name: Bad_Nam', input: '\x7f' },
        { waitFor: 'Workstation name: Bad_Na', input: '\x7f' },
        { waitFor: 'Workstation name: Bad_N', input: '\x7f' },
        { waitFor: 'Workstation name: Bad_', input: '\x7f' },
        { waitFor: 'Workstation name: Bad', input: '\x7f' },
        { waitFor: 'Workstation name: Ba', input: '\x7f' },
        { waitFor: 'Workstation name: B', input: '\x7f' },
        { waitFor: 'Workstation name:', input: 'valid-name' },
        { waitFor: 'Workstation name: valid-name', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(12);
    expect(observed.output).toContain('lowercase DNS label');
    expect(observed.result).toBe('valid-name');
  });

  it('should describe token acquisition while keeping the secret prompt free of name validation', async () => {
    const input = emptyInput();
    const observed = await driveInk(
      async (interaction) => {
        await resolveInteractiveInputs(dependencies, input, {
          options: { localCredentials: false },
          interaction,
          required: ['providerToken'],
        });

        return input.providerToken;
      },
      [{ waitFor: 'Sprites API token', input: ['Bad_Name', '\r'] }],
    );

    expect(observed.matchedSteps, observed.output).toBe(1);
    expect(observed.output).toContain('https://sprites.dev/account');
    expect(observed.output).toContain('intended organization');
    expect(observed.output).not.toContain('Bad_Name');
    expect(observed.result).toBe('Bad_Name');
  });
});
