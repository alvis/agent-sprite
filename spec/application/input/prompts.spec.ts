import { describe, expect, it } from 'vitest';

import { commandError } from '#application/failures';
import { resolveInteractiveInputs } from '#application/input/prompts';

import { driveInk } from '../../fixtures/ink';
import { DISABLED_NETWORK_PROFILE } from '../../fixtures/profile';

import { dependencies } from '../../mocks/dependencies';

import type { ResolvedInputs } from '#application/input/types';

/** fresh local input state without provider or credential-store access */
function emptyInput(): ResolvedInputs {
  return {
    profile: DISABLED_NETWORK_PROFILE,
    runtimeEnv: {},
    sources: {},
    missing: [],
  };
}

describe('fn:resolveInteractiveInputs', () => {
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
