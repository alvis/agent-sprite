import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createEnvironmentAccess } from '#adapters/guest/environment/store';
import { UPDATE_STATUS_PATH } from '#adapters/guest/platform/layout';
import { registry } from '#composition/registry';

import { environmentOf } from '../../../fixtures/environment';
import { DISABLED_NETWORK_PROFILE } from '../../../fixtures/profile';
import { createFilesystemSprite, guestOf } from '../../../mocks/sprites';

const access = createEnvironmentAccess(registry);
const RECORDED = environmentOf(DISABLED_NETWORK_PROFILE);

describe('environment access on a guest', () => {
  it('should find nothing before a record exists and read a written record', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-environment-'),
    );
    const guest = guestOf(createFilesystemSprite({ root: directory.path }));

    await expect(access.find(guest)).resolves.toBeUndefined();
    await access.write(guest, RECORDED);

    await expect(access.find(guest)).resolves.toEqual(RECORDED);
    await expect(access.read(guest)).resolves.toEqual(RECORDED);
  });

  it('should refuse an invalid profile before writing a record', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-environment-'),
    );
    const guest = guestOf(createFilesystemSprite({ root: directory.path }));
    const invalid = {
      ...RECORDED,
      profile: {
        ...RECORDED.profile,
        options: { ...RECORDED.profile.options, updateDueIntervalDays: 0 },
      },
    };

    await expect(access.write(guest, invalid)).rejects.toMatchObject({
      code: 'INPUT',
    });
    await expect(access.find(guest)).resolves.toBeUndefined();
  });

  it('should record profile changes and reject stale integration choices', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-environment-'),
    );
    const guest = guestOf(createFilesystemSprite({ root: directory.path }));
    const updated = {
      ...DISABLED_NETWORK_PROFILE,
      options: {
        ...DISABLED_NETWORK_PROFILE.options,
        updateDueIntervalDays: 14,
      },
    };
    await access.write(guest, RECORDED);

    await access.writeProfile(guest, updated);

    await expect(access.read(guest)).resolves.toMatchObject({
      profile: updated,
      schedule: { dueDays: 14 },
    });
    await expect(access.assertProfile(guest, updated)).resolves.toBeUndefined();
    await expect(
      access.assertProfile(guest, {
        ...updated,
        options: { ...updated.options, isExitNodeEnabled: true },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('should retain the enrolling network with its recorded device identity', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-environment-'),
    );
    const guest = guestOf(createFilesystemSprite({ root: directory.path }));
    await access.write(guest, RECORDED);

    await access.identityRecorder(
      guest,
      'tailscale',
    )({
      deviceId: 'device-1',
      ip: '100.101.102.103',
    });

    await expect(access.read(guest)).resolves.toMatchObject({
      networkIdentity: {
        network: 'tailscale',
        deviceId: 'device-1',
        ip: '100.101.102.103',
      },
    });
  });

  it('should return the updater record when it exists', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-environment-'),
    );
    const guest = guestOf(createFilesystemSprite({ root: directory.path }));
    await expect(access.readUpdateStatus(guest)).resolves.toBeUndefined();
    await mkdir(join(directory.path, dirname(UPDATE_STATUS_PATH)), {
      recursive: true,
    });
    await writeFile(
      join(directory.path, UPDATE_STATUS_PATH),
      JSON.stringify({ startedAt: '2026-10-26T00:00:00Z', tools: [] }),
    );

    await expect(access.readUpdateStatus(guest)).resolves.toEqual({
      startedAt: '2026-10-26T00:00:00Z',
      tools: [],
    });
  });
});
