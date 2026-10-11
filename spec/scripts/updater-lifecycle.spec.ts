import { appendFile, mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runHeldUpdate } from '#scripts/updater-lifecycle';

interface FailureObservation {
  error: unknown;
  releaseError: unknown;
  releaseOnly: boolean;
  releaseFailed: boolean;
}

describe('fn:runHeldUpdate', () => {
  it('should release after work failure, then retains primary, prior, release, and recorder errors', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-held-update-'),
    );
    const path = join(directory.path, 'actions.log');
    const append = async (action: string) => appendFile(path, `${action}\n`);
    const prior = new Error('prior install cause');
    const primary = new Error('install failed', { cause: prior });
    const release = new Error('release failed');
    const recorder = new Error('status write failed');
    let recorded: FailureObservation | undefined;

    const failure: unknown = await runHeldUpdate({
      acquire: async () => append('acquire'),
      work: async () => {
        await append('work');
        throw primary;
      },
      release: async () => {
        await append('release');
        throw release;
      },
      recordFailure: async (observation) => {
        await append('record');
        recorded = observation;
        throw recorder;
      },
    }).catch((error: unknown) => error);

    expect((await readFile(path, 'utf8')).trim().split('\n')).toEqual([
      'acquire',
      'work',
      'release',
      'record',
    ]);
    expect(recorded).toEqual({
      error: primary,
      releaseError: release,
      releaseOnly: false,
      releaseFailed: true,
    });
    expect(failure).toBe(primary);
    expect(primary.cause).toBeInstanceOf(AggregateError);
    expect((primary.cause as AggregateError).errors).toEqual([
      prior,
      release,
      recorder,
    ]);
  });

  it('should retain a release-only failure when recording it also fails', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-held-release-'),
    );
    const path = join(directory.path, 'actions.log');
    const append = async (action: string) => appendFile(path, `${action}\n`);
    const release = new Error('release failed after successful work');
    const recorder = new Error('status write failed');
    let recorded: FailureObservation | undefined;

    const failure: unknown = await runHeldUpdate({
      acquire: async () => append('acquire'),
      work: async () => append('work'),
      release: async () => {
        await append('release');
        throw release;
      },
      recordFailure: async (observation) => {
        await append('record');
        recorded = observation;
        throw recorder;
      },
    }).catch((error: unknown) => error);

    expect((await readFile(path, 'utf8')).trim().split('\n')).toEqual([
      'acquire',
      'work',
      'release',
      'record',
    ]);
    expect(recorded).toEqual({
      error: release,
      releaseError: undefined,
      releaseOnly: true,
      releaseFailed: true,
    });
    expect(failure).toBe(release);
    expect((release.cause as AggregateError).errors).toEqual([recorder]);
  });

  it('should not run work or release after acquisition fails', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-held-acquire-'),
    );
    const path = join(directory.path, 'actions.log');
    const append = async (action: string) => appendFile(path, `${action}\n`);
    const primary = new Error('acquire failed');
    const recorder = new Error('status write failed');

    const failure: unknown = await runHeldUpdate({
      acquire: async () => {
        await append('acquire');
        throw primary;
      },
      work: async () => append('work'),
      release: async () => append('release'),
      recordFailure: async () => {
        await append('record');
        throw recorder;
      },
    }).catch((error: unknown) => error);

    expect((await readFile(path, 'utf8')).trim().split('\n')).toEqual([
      'acquire',
      'record',
    ]);
    expect(failure).toBe(primary);
    expect((primary.cause as AggregateError).errors).toEqual([recorder]);
  });
});
