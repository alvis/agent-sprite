import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ENVIRONMENT_PATH } from '#adapters/guest/platform/layout';
import { prepareGuestSection } from '#application/setup';
import { registry } from '#composition/registry';
import { summarizeProfile } from '#domain/recorded';
import { OperationContext, withOperation } from '#kernel/operation';

import { environmentOf } from '../../fixtures/environment';
import { DISABLED_NETWORK_PROFILE } from '../../fixtures/profile';
import { dependencies, dependenciesWith } from '../../mocks/dependencies';
import { createFilesystemSprite, workstationOf } from '../../mocks/sprites';

import type { WorkstationProfile } from '#domain/profile';

// The transport stand-in keeps real setup sessions over isolated guest files.
vi.mock(
  '#adapters/guest/platform/session/open',
  async () => import('../../mocks/session'),
);

describe('fn:prepareGuestSection', () => {
  it.each([
    { release: undefined, expected: 'stable' },
    { release: 'nightly', expected: 'nightly' },
  ])(
    'should resolve a declared release before reporting a channel change (release=$expected)',
    async ({ release, expected }) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-prepared-release-'),
      );
      const sprite = createFilesystemSprite({ root: directory.path });
      await sprite
        .filesystem()
        .writeFile(
          ENVIRONMENT_PATH,
          JSON.stringify(environmentOf(DISABLED_NETWORK_PROFILE)),
        );
      const target = workstationOf(sprite);
      const prepared = await prepareGuestSection(dependencies, {
        ...target,
        supplied: { options: { agentRelease: release } },
        sources: { processEnv: {}, fileEnv: {}, profile: {} },
        section: 'agent',
        options: { release, nonInteractive: true },
        mutation: { started: false },
      });

      expect({
        changed: prepared.context.isReleaseChanged,
        channel: prepared.context.profile.options.agentRelease,
        persisted: (await dependencies.guest.environment.find(prepared.guest))
          ?.profile.options.agentRelease,
      }).toEqual({ changed: true, channel: expected, persisted: expected });
      await target.connection.close();
    },
  );

  it('should preserve a ready profile and its current session when the section changes no selection', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-preparation-preserved-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const before = JSON.stringify(environmentOf(DISABLED_NETWORK_PROFILE));
    await sprite.filesystem().writeFile(ENVIRONMENT_PATH, before);
    const target = workstationOf(sprite);
    const mutation = { started: false };
    const prepared = await prepareGuestSection(dependencies, {
      ...target,
      supplied: { options: {} },
      sources: { processEnv: {}, fileEnv: {}, profile: {} },
      section: 'git',
      options: { gitIdentity: false, nonInteractive: true },
      mutation,
    });

    expect({
      connection: prepared.context.connection,
      persistsProfile: prepared.context.persistsProfile,
      started: mutation.started,
      recorded: await sprite.filesystem().readFile(ENVIRONMENT_PATH, 'utf8'),
    }).toEqual({
      connection: target.connection,
      persistsProfile: false,
      started: false,
      recorded: before,
    });
    await target.connection.close();
  });

  it('should prepare an unrecorded workstation for full recovery without prematurely marking it configured', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-unrecorded-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const target = workstationOf(sprite);
    const workstation = {
      ...target.workstation,
      metadata: {
        ...target.workstation.metadata,
        profile: summarizeProfile(DISABLED_NETWORK_PROFILE),
      },
    };
    const mutation = { started: false };

    const prepared = await prepareGuestSection(dependencies, {
      ...target,
      workstation,
      supplied: { options: {} },
      sources: { processEnv: {}, fileEnv: {}, profile: {} },
      section: 'all',
      options: {
        nonInteractive: true,
        localCredentials: false,
        github: false,
        gitIdentity: false,
      },
      mutation,
    });

    expect({
      profile: prepared.context.profile,
      persistsProfile: prepared.context.persistsProfile,
      releaseChanged: prepared.context.isReleaseChanged,
      started: mutation.started,
      recorded: await dependencies.guest.environment.find(prepared.guest),
    }).toEqual({
      profile: {
        ...DISABLED_NETWORK_PROFILE,
        options: {
          ...DISABLED_NETWORK_PROFILE.options,
          agentRelease: 'stable',
        },
      },
      persistsProfile: true,
      releaseChanged: true,
      started: false,
      recorded: undefined,
    });
    await target.connection.close();
  });

  it('should report unresolved proxy credentials and the actual unavailable terminal without changing the guest', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-missing-setup-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const before = JSON.stringify(environmentOf(DISABLED_NETWORK_PROFILE));
    await sprite.filesystem().writeFile(ENVIRONMENT_PATH, before);
    const target = workstationOf(sprite);
    const mutation = { started: false };
    const operation = new OperationContext({
      signal: new AbortController().signal,
    });
    operation.setPromptBlocker('stdin is not a terminal');

    await expect(
      withOperation(operation, async () =>
        prepareGuestSection(dependencies, {
          ...target,
          supplied: { options: { isProxyEnabled: true } },
          sources: { processEnv: {}, fileEnv: {}, profile: {} },
          section: 'proxy',
          options: {
            proxy: true,
            nonInteractive: true,
            localCredentials: false,
          },
          mutation,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'INPUT',
      details: expect.arrayContaining([
        expect.stringMatching(/CLIProxyAPI/iu),
        expect.stringContaining('stdin is not a terminal'),
      ]),
    });
    expect({
      started: mutation.started,
      recorded: await sprite.filesystem().readFile(ENVIRONMENT_PATH, 'utf8'),
    }).toEqual({ started: false, recorded: before });
    await target.connection.close();
  });

  it('should persist resized requirements through the replacement session and close the retired session', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-resize-preparation-'),
    );
    const profile: WorkstationProfile = {
      ...DISABLED_NETWORK_PROFILE,
      provider: 'fly-machine',
    };
    const original = createFilesystemSprite({
      root: join(directory.path, 'old'),
    });
    const replacement = createFilesystemSprite({
      root: join(directory.path, 'new'),
    });
    for (const sprite of [original, replacement]) {
      await sprite
        .filesystem()
        .writeFile(ENVIRONMENT_PATH, JSON.stringify(environmentOf(profile)));
    }
    const target = workstationOf(original);
    const next = workstationOf(replacement);
    const provider = registry.providers['fly-machine'].authenticate({
      credential: 'test-fly-credential',
      restorableServices: [],
    });
    const workstation = {
      ...target.workstation,
      machine: provider.machines[0],
    };
    vi.spyOn(provider, 'resize').mockImplementation(async (record, offer) => ({
      ...record,
      machine: offer,
    }));
    const close = vi.spyOn(target.connection, 'close');
    const wired = dependenciesWith({
      guest: {
        ...dependencies.guest,
        session: { connect: () => next.connection },
      },
    });
    const mutation = { started: false };

    const prepared = await prepareGuestSection(wired, {
      ...target,
      provider,
      workstation,
      supplied: { options: { minCpus: 4 } },
      sources: { processEnv: {}, fileEnv: {}, profile: {} },
      section: 'tools',
      options: { cpu: 4, nonInteractive: true, yes: true },
      mutation,
    });

    expect({
      cpus: prepared.context.workstation.machine?.cpus,
      connection: prepared.context.connection,
      persisted: (await dependencies.guest.environment.find(prepared.guest))
        ?.profile.options.minCpus,
      retiredCloses: close.mock.calls,
      started: mutation.started,
    }).toEqual({
      cpus: 4,
      connection: next.connection,
      persisted: 4,
      retiredCloses: [[]],
      started: true,
    });
    expect(
      (
        await dependencies.guest.environment.find(
          await target.connection.guest(),
        )
      )?.profile.options.minCpus,
    ).toBe(profile.options.minCpus);
    await target.connection.close();
    await next.connection.close();
  });

  it.each([false, true])(
    'should preserve persistence failures and close only a replacement session (resize=%s)',
    async (resize) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-preparation-failure-'),
      );
      const profile: WorkstationProfile = {
        ...DISABLED_NETWORK_PROFILE,
        provider: 'fly-machine',
      };
      const original = createFilesystemSprite({
        root: join(directory.path, 'old'),
      });
      const replacement = createFilesystemSprite({
        root: join(directory.path, 'new'),
      });
      for (const sprite of [original, replacement]) {
        await sprite
          .filesystem()
          .writeFile(ENVIRONMENT_PATH, JSON.stringify(environmentOf(profile)));
      }
      const target = workstationOf(original);
      const next = workstationOf(replacement);
      const provider = registry.providers['fly-machine'].authenticate({
        credential: 'test-fly-credential',
        restorableServices: [],
      });
      const workstation = {
        ...target.workstation,
        machine: provider.machines[0],
      };
      vi.spyOn(provider, 'resize').mockImplementation(
        async (record, offer) => ({ ...record, machine: offer }),
      );
      const oldClose = vi.spyOn(target.connection, 'close');
      const newClose = vi.spyOn(next.connection, 'close');
      const failure = new Error('guest storage is read-only');
      const wired = dependenciesWith({
        guest: {
          ...dependencies.guest,
          session: { connect: () => next.connection },
          environment: {
            ...dependencies.guest.environment,
            writeProfile: async () => {
              throw failure;
            },
          },
        },
      });
      const mutation = { started: false };

      await expect(
        prepareGuestSection(wired, {
          ...target,
          provider,
          workstation,
          supplied: {
            options: resize ? { minCpus: 4 } : { updateDueIntervalDays: 2 },
          },
          sources: { processEnv: {}, fileEnv: {}, profile: {} },
          section: 'tools',
          options: {
            cpu: resize ? 4 : undefined,
            updateDueDays: 2,
            nonInteractive: true,
            yes: true,
          },
          mutation,
        }),
      ).rejects.toBe(failure);

      expect({
        oldCloses: oldClose.mock.calls,
        newCloses: newClose.mock.calls,
        started: mutation.started,
        recorded: (
          await dependencies.guest.environment.find(
            await target.connection.guest(),
          )
        )?.profile,
      }).toEqual({
        oldCloses: resize ? [[]] : [],
        newCloses: resize ? [[]] : [],
        started: true,
        recorded: profile,
      });
      await target.connection.close();
      await next.connection.close();
    },
  );
});
