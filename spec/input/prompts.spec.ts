import { describe, expect, it } from 'vitest';

import { commandError } from '#errors';
import { resolveInteractiveInputs } from '#input/prompts';

import { driveInk } from '../fixtures/ink.js';

import type { ResolvedInputs } from '#input';

/** fresh local input state without provider or credential-store access */
function emptyInput(): ResolvedInputs {
  return {
    integrations: { tailscale: false, exitNode: false, cliproxyapi: false },
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
          await resolveInteractiveInputs(input, {
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
        await resolveInteractiveInputs(input, {
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
        await resolveInteractiveInputs(input, {
          options: { localCredentials: false },
          interaction,
          required: ['spritesToken'],
        });

        return input.spritesToken;
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
