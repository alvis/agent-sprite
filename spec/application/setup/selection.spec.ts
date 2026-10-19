import { describe, expect, it } from 'vitest';

import { replaceNetworkCredential } from '#application/setup/credentials';
import { selectSetupSection } from '#application/setup/selection';

import { driveInk } from '../../fixtures/ink';
import { dependencies } from '../../mocks/dependencies';

describe('workflow:interactive navigation', () => {
  it('should return from network choices and declines a shared credential before reading a key', async () => {
    const observed = await driveInk(
      async (interaction) => {
        const section = await selectSetupSection({}, interaction);
        const localCredential = await replaceNetworkCredential(dependencies, {
          interaction,
        });

        return { section, localCredential };
      },
      [
        { waitFor: 'Choose setup section', input: 'Network' },
        { waitFor: 'Search: Network', input: '\r' },
        { waitFor: 'Guest networking and', input: '\x1b' },
        { waitFor: 'Choose setup section', input: 'Git / Jujutsu' },
        { waitFor: 'Search: Git / Jujutsu', input: '\r' },
        { waitFor: 'Shared by all workstations', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(6);
    expect(observed.result).toMatchObject({
      section: 'git',
      localCredential: { localCredential: { status: 'unchanged' } },
    });
    expect(observed.output).not.toContain(
      'New local Tailscale management API key',
    );
  });
});
