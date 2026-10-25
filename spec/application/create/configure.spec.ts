import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { configureNewWorkstation } from '#application/create/configure';
import {
  normalizePluginOptions,
  resolvePluginActions,
} from '#application/plugins';
import { registry } from '#composition/registry';

import { DISABLED_NETWORK_PROFILE } from '../../fixtures/profile';

import { dependencies } from '../../mocks/dependencies';
import {
  createFilesystemSprite,
  guestOf,
  providerOf,
} from '../../mocks/sprites';

import type { Sprite } from '@fly/sprites';

import type { ConfigureNewWorkstationParams } from '#application/create/configure';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { SetupSession } from '#application/ports/session';

// the install plan is a guest run; only the configuration it hands over is under test
vi.mock('#application/installation/install', () => ({
  installWorkstation: vi.fn(
    async (
      _mechanics: unknown,
      params: { connection: SetupSession; beforeServices?: GuestChannelStep },
    ) => params.beforeServices?.(await params.connection.guest()),
  ),
}));
vi.mock('#application/installation/readiness', () => ({
  markInstallationReady: vi.fn(async () => undefined),
}));

type GuestChannelStep = (guest: GuestChannel) => Promise<void>;

type Configuration = ConfigureNewWorkstationParams['configuration'];

const plugins = resolvePluginActions(normalizePluginOptions({}));
const profile = { ...DISABLED_NETWORK_PROFILE, harnesses: [] };

/**
 * stands in for the root setup session over the SDK mock
 * @param sprite SDK mock the session reaches
 * @returns a session that hands out the mock's guest channel
 */
function connectionOf(sprite: Sprite): SetupSession {
  return {
    guest: async () => guestOf(sprite),
  } satisfies Partial<SetupSession> as Partial<SetupSession> as SetupSession;
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
});
