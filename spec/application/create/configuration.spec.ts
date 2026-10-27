import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { configureNewWorkstation } from '#application/create/configuration';
import {
  normalizePluginOptions,
  resolvePluginActions,
} from '#application/plugins';
import { registry } from '#composition/registry';
import { Secret } from '#kernel/secret';

import { environmentOf } from '../../fixtures/environment';
import {
  DISABLED_NETWORK_PROFILE,
  TAILSCALE_PROFILE,
} from '../../fixtures/profile';

import { dependencies } from '../../mocks/dependencies';
import { standInSession } from '../../mocks/session';
import {
  createFilesystemSprite,
  guestOf,
  providerOf,
} from '../../mocks/sprites';

import type { Sprite } from '@fly/sprites';

import type { ConfigureNewWorkstationParams } from '#application/create/configuration';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { Interaction } from '#application/ports/interaction';
import type { SetupSession } from '#application/ports/session';
import type { WorkstationProfile } from '#domain/profile';

// the install plan is a guest run; only the configuration it hands over is under test
vi.mock(
  '#application/installation',
  () =>
    ({
      installWorkstation: vi.fn<
        typeof import('#application/installation').installWorkstation
      >(async (_mechanics, params) => {
        await params.beforeServices?.(await params.connection.guest());

        return environmentOf(params.profile);
      }),
    }) satisfies Pick<
      typeof import('#application/installation'),
      'installWorkstation'
    >,
);
vi.mock(
  '#application/installation/readiness',
  () =>
    ({
      markInstallationReady: vi.fn(async () => undefined),
    }) satisfies Pick<
      typeof import('#application/installation/readiness'),
      'markInstallationReady'
    >,
);

type Configuration = ConfigureNewWorkstationParams['configuration'];

const plugins = resolvePluginActions(normalizePluginOptions({}));
const profile = { ...DISABLED_NETWORK_PROFILE, harnesses: [] };

/**
 * stands in for the root setup session over the SDK mock
 * @param sprite SDK mock the session reaches
 * @returns a session that hands out the mock's guest channel
 */
function connectionOf(sprite: Sprite): SetupSession {
  const channel = guestOf(sprite);
  const root = standInSession(channel);

  return {
    ...root,
    open: async () => root,
    reopen: async () => root,
    lend: async () => root,
    close: async () => undefined,
    guest: async () => channel,
  } satisfies SetupSession;
}

/**
 * records progress from the configuration workflow
 * @param messages selected progress updates
 * @returns a prompt boundary that rejects unexpected prompts
 */
function progressOf(messages: string[]): Interaction {
  const unexpected = async (): Promise<never> => {
    throw new Error('Configuration unexpectedly requested a prompt');
  };

  return {
    input: unexpected,
    secret: unexpected,
    select: unexpected,
    multiselect: unexpected,
    confirm: unexpected,
    progress: ({ stage, message }) => {
      if (stage === 'network') {
        messages.push(message);
      }
    },
    status: () => undefined,
  } satisfies Interaction;
}

/**
 * builds the guest mechanics whose native steps and label record their order
 * @param calls receives the name of each step in the order it runs
 * @returns the dependencies configuration runs on
 */
function recordingDependencies(
  calls: string[],
): Pick<ApplicationDependencies, 'registry' | 'guest'> {
  const { guest } = dependencies;

  return {
    registry,
    guest: {
      ...guest,
      label: { ...guest.label, write: vi.fn(async () => undefined) },
      native: {
        ...guest.native,
        configureRuntimeEnv: vi.fn(async () => {
          calls.push('configureNative');
        }),
        runSetupFile: vi.fn(async (_guest, contents: Buffer) => {
          calls.push(`runSetupFile:${contents.toString()}`);
        }),
      },
    },
  };
}

describe('fn:configureNewWorkstation', () => {
  it('should run the setup file after the native configuration when one is selected', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-configure-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const calls: string[] = [];
    const configuration: Configuration = {
      hostname: 'box',
      profile,
      runtimeEnv: {},
      setupFile: Buffer.from('#!/bin/sh\n'),
      plugins,
    };

    await configureNewWorkstation(recordingDependencies(calls), {
      provider: providerOf(sprite.client),
      connection: connectionOf(sprite),
      configuration,
    });

    expect(calls).toEqual(['configureNative', 'runSetupFile:#!/bin/sh\n']);
  });

  it('should not run a setup file when none is selected', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-configure-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const calls: string[] = [];

    await configureNewWorkstation(recordingDependencies(calls), {
      provider: providerOf(sprite.client),
      connection: connectionOf(sprite),
      configuration: { hostname: 'box', profile, runtimeEnv: {}, plugins },
    });

    expect(calls).toEqual(['configureNative']);
  });

  it.each([
    { exitNode: false, notice: 'connectivity' },
    { exitNode: true, notice: 'exit-node' },
  ])(
    'should enroll Tailscale with $notice progress',
    async ({ exitNode, notice }) => {
      const selectedExitNode = exitNode ? { exitNode: 'selected-node' } : {};
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-configure-network-'),
      );
      const sprite = createFilesystemSprite({ root: directory.path });
      const calls: string[] = [];
      const messages: string[] = [];
      const profile = {
        ...TAILSCALE_PROFILE,
        harnesses: [],
        options: {
          ...TAILSCALE_PROFILE.options,
          isExitNodeEnabled: exitNode,
        },
      } satisfies WorkstationProfile;
      const connection = connectionOf(sprite);
      using enroll = vi
        .spyOn(registry.networks.tailscale, 'enroll')
        .mockImplementation(async () => {
          calls.push('network enrolled');
        });

      const guest = await configureNewWorkstation(
        recordingDependencies(calls),
        {
          provider: providerOf(sprite.client),
          connection,
          interaction: progressOf(messages),
          configuration: {
            hostname: 'box',
            profile,
            authKey: Secret.fromHost('provider-api', 'selected-auth-key'),
            ...selectedExitNode,
            runtimeEnv: {},
            plugins,
          },
        },
      );

      expect({
        guest,
        messages,
        calls,
        enrollment: enroll.mock.calls,
      }).toEqual({
        guest: await connection.guest(),
        messages: [expect.stringContaining(notice)],
        calls: ['network enrolled', 'configureNative'],
        enrollment: [
          [
            expect.anything(),
            expect.objectContaining({
              hostname: 'box',
              exitNode: exitNode ? 'selected-node' : undefined,
            }),
          ],
        ],
      });
    },
  );

  it('should apply selected GitHub, Git, and native plugin configuration', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-configure-options-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const calls: string[] = [];
    const wired = recordingDependencies(calls);
    const profile = {
      ...DISABLED_NETWORK_PROFILE,
      harnesses: ['claude'],
    } satisfies WorkstationProfile;
    const selectedPlugins = resolvePluginActions(
      normalizePluginOptions({
        harnessPlugins: { claude: { disablePlugins: ['old-plugin'] } },
      }),
      profile.harnesses,
    );
    const connection = connectionOf(sprite);
    using github = vi
      .spyOn(wired.guest.native, 'configureGithub')
      .mockImplementation(async () => {
        calls.push('github configured');
      });
    using git = vi
      .spyOn(wired.guest.native, 'configureGit')
      .mockImplementation(async () => {
        calls.push('git configured');
      });
    vi.spyOn(wired.guest.hub, 'record').mockImplementation(async () => {
      calls.push('hub recorded');
    });
    vi.spyOn(registry.harnesses.claude, 'configure').mockImplementation(
      async () => {
        calls.push('harness configured');
      },
    );
    vi.spyOn(registry.harnesses.claude.hooks, 'install').mockImplementation(
      async () => {
        calls.push('hook installed');
      },
    );
    using plugin = vi
      .spyOn(registry.harnesses.claude.plugins, 'apply')
      .mockImplementation(async () => {
        calls.push('plugin applied');
      });

    const guest = await configureNewWorkstation(wired, {
      provider: providerOf(sprite.client),
      connection,
      configuration: {
        hostname: 'box',
        profile,
        githubToken: 'selected-github-token',
        githubHost: 'github.com',
        gitIdentity: {
          authorName: 'A User',
          authorEmail: 'author@example.test',
          committerName: 'A User',
          committerEmail: 'author@example.test',
        },
        runtimeEnv: {},
        plugins: selectedPlugins,
      },
    });

    expect({
      guest,
      calls,
      github: github.mock.calls,
      git: git.mock.calls,
      plugin: plugin.mock.calls,
    }).toEqual({
      guest: await connection.guest(),
      calls: [
        'configureNative',
        'github configured',
        'git configured',
        'hub recorded',
        'harness configured',
        'hook installed',
        'plugin applied',
      ],
      github: [
        [
          expect.anything(),
          expect.any(Secret),
          expect.objectContaining({ hostname: 'github.com' }),
        ],
      ],
      git: [
        [
          expect.anything(),
          expect.objectContaining({ authorEmail: 'author@example.test' }),
        ],
      ],
      plugin: [
        [
          expect.anything(),
          expect.objectContaining({ disablePlugins: ['old-plugin'] }),
        ],
      ],
    });
  });
});
