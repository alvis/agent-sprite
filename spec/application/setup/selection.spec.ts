import { describe, expect, it } from 'vitest';

import { replaceNetworkCredential } from '#application/setup/credentials';
import { selectSetupSection } from '#application/setup/selection';

import { driveInk } from '../../fixtures/ink';
import { pluginFlags } from '../../fixtures/plugin-flags';
import { dependencies } from '../../mocks/dependencies';

describe('fn:selectSetupSection', () => {
  it.each([
    { options: { withPairCode: true }, section: 'agent' },
    {
      options: pluginFlags({ disableCodexPlugin: ['coding@alvis'] }),
      section: 'plugins',
    },
    {
      options: pluginFlags({
        section: 'plugins',
        disableCodexPlugin: ['coding@alvis'],
      }),
      section: 'plugins',
    },
    { options: { setupFile: 'setup.sh' }, section: 'system' },
    { options: { envFile: 'runtime.vars' }, section: 'env' },
  ] as const)(
    'should select $section from explicit actions',
    async ({ options, section }) => {
      await expect(selectSetupSection(options)).resolves.toBe(section);
    },
  );

  it('should reject explicit plugin actions for a different section', async () => {
    const options = pluginFlags({
      section: 'tools',
      disableCodexPlugin: ['coding@alvis'],
    });

    await expect(selectSetupSection(options)).rejects.toMatchObject({
      message: expect.stringContaining('conflict'),
    });
  });

  it('should require a section when prompting is unavailable or explicitly disabled', async () => {
    await expect(selectSetupSection({})).rejects.toMatchObject({
      message: expect.stringContaining('--section'),
    });
    await expect(
      driveInk(
        async (interaction) =>
          selectSetupSection({ nonInteractive: true }, interaction),
        [],
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('--section') });
  });
});

describe('interactive navigation', () => {
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
