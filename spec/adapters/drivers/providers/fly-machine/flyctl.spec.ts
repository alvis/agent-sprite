import { mkdtempDisposable } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  deriveSshToken,
  flyctlConfigDirectory,
} from '#adapters/drivers/providers/fly-machine/flyctl';

import type { Options, Result, ResultPromise } from 'execa';

const child = vi.hoisted(() => ({
  run: vi.fn<
    (
      program: string,
      args: readonly string[],
      options?: Options,
    ) => ResultPromise
  >(
    (_program, args): ResultPromise =>
      Promise.resolve({
        exitCode: 0,
        stdout:
          args[1] === 'attenuate'
            ? 'FlyV1 permission,discharge'
            : JSON.stringify([
                { location: 'https://api.fly.io/v1', caveats: [] },
                { location: 'https://api.fly.io/v1', caveats: [] },
                { location: 'https://discharge.fly.io', caveats: [] },
              ]),
        stderr: '',
      } satisfies Partial<Result> as Result) as ResultPromise,
  ),
}));
vi.mock('execa', () => {
  return {
    execa: child.run as typeof child.run & typeof import('execa').execa,
  } satisfies Partial<typeof import('execa')>;
});

describe('Fly SSH token derivation', () => {
  it('should reject attenuation that omits the organization discharge', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'fly-token-test-'),
    );
    vi.stubEnv('XDG_CONFIG_HOME', directory.path);
    child.run.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'FlyV1 permission',
      stderr: '',
    } satisfies Partial<Result> as Result);

    await expect(
      deriveSshToken('FlyV1 organization', 42),
    ).rejects.toMatchObject({
      code: 'authentication',
      message: expect.stringContaining(
        'is not one permission with its discharge',
      ),
    });
  });

  it('should reject a derived token that flyctl cannot decode', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'fly-token-test-'),
    );
    vi.stubEnv('XDG_CONFIG_HOME', directory.path);
    const run = child.run.getMockImplementation()!;
    child.run
      .mockImplementationOnce(run)
      .mockImplementationOnce(run)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'invalid macaroon',
      } satisfies Partial<Result> as Result);

    await expect(
      deriveSshToken('FlyV1 organization', 42),
    ).rejects.toMatchObject({
      code: 'authentication',
      message: expect.stringContaining(
        'did not attenuate into two Fly permissions',
      ),
    });
  });

  it('should report attenuation that ends without an exit status', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'fly-token-test-'),
    );
    vi.stubEnv('XDG_CONFIG_HOME', directory.path);
    child.run.mockResolvedValueOnce({
      exitCode: undefined,
      stdout: '',
      stderr: '',
    } satisfies Partial<Result> as Result);

    await expect(
      deriveSshToken('FlyV1 organization', 42),
    ).rejects.toMatchObject({
      code: 'failed',
      message: expect.stringContaining('timeout'),
    });
  });

  it('should use the home configuration directory when XDG_CONFIG_HOME is absent', () => {
    vi.stubEnv('XDG_CONFIG_HOME', undefined);

    expect(flyctlConfigDirectory()).toBe(
      join(homedir(), '.config', 'open-agent', 'flyctl'),
    );
  });
});
