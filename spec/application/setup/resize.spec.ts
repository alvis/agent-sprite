import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { resizeWhenRequested } from '#application/setup/resize';

import { driveInk } from '../../fixtures/ink';
import { DISABLED_NETWORK_PROFILE } from '../../fixtures/profile';
import { dependencies } from '../../mocks/dependencies';
import { createFilesystemSprite, workstationOf } from '../../mocks/sprites';

import type { ProviderDriver } from '#application/ports/drivers';
import type { WorkstationRecord } from '#domain/workstation';

const small = { label: 'small', cpus: 1, memoryGb: 1 };
const large = { label: 'large', cpus: 4, memoryGb: 4 };
const workstation = workstationOf(
  createFilesystemSprite({ root: tmpdir() }),
).workstation;
const capabilities =
  dependencies.registry.providers['fly-machine'].capabilities;
const profile = {
  ...DISABLED_NETWORK_PROFILE,
  options: { ...DISABLED_NETWORK_PROFILE.options, minCpus: 4, minMemoryGb: 4 },
};
const resize = vi.fn<ProviderDriver['resize']>(async (record, machine) => ({
  ...record,
  machine,
}));
const provider = {
  displayName: 'Test provider',
  capabilities,
  machines: [small, large],
  resize,
} satisfies Partial<ProviderDriver> as Partial<ProviderDriver> as ProviderDriver;

describe('fn:resizeWhenRequested', () => {
  it('should reject an unavailable minimum and leave an already matching machine unchanged', async () => {
    await expect(
      resizeWhenRequested({
        provider,
        workstation,
        profile: { ...profile, options: { ...profile.options, minCpus: 100 } },
        supplied: { options: { minCpus: 100 } },
        options: {},
      }),
    ).rejects.toMatchObject({ code: 'INPUT' });

    await expect(
      resizeWhenRequested({
        provider,
        workstation: { ...workstation, machine: large },
        profile,
        supplied: { options: { minCpus: 4 } },
        options: {},
      }),
    ).resolves.toEqual({ ...workstation, machine: large });
    expect(resize.mock.calls).toEqual([]);
  });

  it.each([false, true])(
    'should require explicit restart consent with noninteractive mode %s',
    async (nonInteractive) => {
      const invoke = async (
        interaction?: Parameters<typeof resizeWhenRequested>[0]['interaction'],
      ): Promise<WorkstationRecord> =>
        resizeWhenRequested({
          provider,
          workstation,
          profile,
          supplied: { options: { minCpus: 4 } },
          options: { nonInteractive },
          interaction,
        });

      await expect(
        nonInteractive ? driveInk(invoke, []) : invoke(),
      ).rejects.toMatchObject({ code: 'USAGE' });
      expect(resize.mock.calls).toEqual([]);
    },
  );

  it('should resize after interactive restart approval', async () => {
    const pending = driveInk(
      async (interaction) =>
        resizeWhenRequested({
          provider,
          workstation,
          profile,
          supplied: { options: { minCpus: 4 } },
          options: {},
          interaction,
        }),
      [{ waitFor: 'Restart', input: 'y' }],
    );

    await expect(pending).resolves.toMatchObject({
      result: { ...workstation, machine: large },
      matchedSteps: 1,
    });
    expect(resize.mock.calls).toEqual([[workstation, large]]);
  });

  it('should leave the machine unchanged when interactive restart approval is declined', async () => {
    await expect(
      driveInk(
        async (interaction) =>
          resizeWhenRequested({
            provider,
            workstation,
            profile,
            supplied: { options: { minCpus: 4 } },
            options: {},
            interaction,
          }),
        [{ waitFor: 'Restart', input: 'n' }],
      ),
    ).rejects.toMatchObject({ action: 'cancel' });
    expect(resize.mock.calls).toEqual([]);
  });

  it('should resize without restart consent when the provider applies sizes live', async () => {
    const live = {
      ...provider,
      capabilities: { ...capabilities, resizeRestarts: false },
    } satisfies ProviderDriver;

    await expect(
      resizeWhenRequested({
        provider: live,
        workstation,
        profile,
        supplied: { options: { minCpus: 4 } },
        options: {},
      }),
    ).resolves.toEqual({ ...workstation, machine: large });
  });
});
