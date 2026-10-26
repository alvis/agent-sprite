import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ReadinessFault } from '#application/readiness';
import { inspectUntilServing } from '#application/serving';
import { exposeWhenServing } from '#application/setup/serving';

import { environmentOf } from '../../fixtures/environment';
import { DISABLED_NETWORK_PROFILE } from '../../fixtures/profile';
import { dependencies } from '../../mocks/dependencies';
import {
  createFilesystemSprite,
  guestOf,
  workstationOf,
} from '../../mocks/sprites';

import type { GuestInspection } from '#domain/observations/inspection';

vi.mock('#application/serving', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#application/serving')>();

  return {
    ...actual,
    inspectUntilServing: vi.fn(actual.inspectUntilServing),
  } satisfies Partial<typeof import('#application/serving')>;
});

describe('fn:exposeWhenServing readiness', () => {
  it('should withhold public exposure when current readiness fails without a version mismatch', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-serving-unready-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const { provider, workstation } = workstationOf(sprite);
    const expose = vi.spyOn(provider, 'expose');
    const profile = DISABLED_NETWORK_PROFILE;
    const inspection = {
      services: [],
      network: { online: false, skipped: true },
      hub: { reachable: false, skipped: true },
      environment: environmentOf(profile),
      probeFailures: [],
      governor: { recorded: false, reason: 'not recorded' },
    } satisfies GuestInspection;
    vi.mocked(inspectUntilServing).mockResolvedValueOnce(inspection);

    const failure = await exposeWhenServing(dependencies, guestOf(sprite), {
      provider,
      workstation,
      profile,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ReadinessFault);
    if (!(failure instanceof ReadinessFault)) {
      throw new Error('Expected readiness failure');
    }
    expect(failure.readiness.ready).toBe(false);
    expect(failure.readiness.failures).toContain('maintenance cron service');
    expect(expose).not.toHaveBeenCalled();
  });
});
