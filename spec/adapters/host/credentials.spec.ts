import { mkdtempDisposable, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  readLocalCredential,
  saveLocalCredential,
} from '#adapters/host/credentials';

import type { CredentialStoreLocation } from '#domain/credentials';

const { homedir, platform, runLocal, sendLocalInput } = vi.hoisted(() => ({
  homedir: vi.fn<typeof import('node:os').homedir>(
    () => '/generated/unused-home',
  ),
  platform: vi.fn<typeof import('node:os').platform>(() => 'darwin'),
  runLocal: vi.fn<typeof import('#adapters/host/process').runLocal>(
    async () => 'generated-secret\r\n',
  ),
  sendLocalInput: vi.fn<typeof import('#adapters/host/process').sendLocalInput>(
    async () => undefined,
  ),
}));

vi.mock(
  'node:os',
  async (importOriginal) =>
    ({
      ...(await importOriginal<typeof import('node:os')>()),
      homedir,
      platform,
    }) satisfies typeof import('node:os'),
);
vi.mock(
  '#adapters/host/process',
  () =>
    ({ runLocal, sendLocalInput }) satisfies Partial<
      typeof import('#adapters/host/process')
    >,
);

describe('fn:readLocalCredential', () => {
  it.each([
    { name: 'default', location: undefined, suffix: [] },
    {
      name: 'selected',
      location: {
        backend: 'keychain',
        path: '/generated/test.keychain',
      } satisfies CredentialStoreLocation,
      suffix: ['/generated/test.keychain'],
    },
  ])(
    'should return the exact secret from the $name keychain',
    async ({ location, suffix }) => {
      const result = await readLocalCredential('sprites', location);

      expect(result).toBe('generated-secret');
      expect(runLocal.mock.calls).toEqual([
        [
          {
            program: '/usr/bin/security',
            arguments: [
              'find-generic-password',
              '-s',
              'open-agent',
              '-a',
              'sprites',
              '-w',
              ...suffix,
            ],
            trimOutput: false,
          },
        ],
      ]);
    },
  );

  it('should return no credential when the selected keychain fails without a fallback', async () => {
    runLocal.mockImplementationOnce(async () => {
      throw new Error('keychain unavailable');
    });

    expect(
      await readLocalCredential('sprites', {
        backend: 'keychain',
        path: '/generated/test.keychain',
      }),
    ).toBeUndefined();
  });

  it('should return no credential when the selected fallback file is missing', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-missing-vault-'),
    );
    platform.mockImplementationOnce(() => 'linux');

    expect(
      await readLocalCredential('sprites', {
        backend: 'protected-file',
        path: join(directory.path, 'missing.json'),
      }),
    ).toBeUndefined();
  });

  it.each(['config', 'home'])(
    'should resolve the default file from the %s directory',
    async (selection) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'oa-default-vault-'),
      );
      const config =
        selection === 'config'
          ? directory.path
          : join(directory.path, '.config');
      await mkdir(join(config, 'open-agent'), { recursive: true });
      await writeFile(
        join(config, 'open-agent', 'credentials.json'),
        '{"sprites":"generated-secret"}',
        { mode: 0o600 },
      );
      platform.mockImplementationOnce(() => 'linux');
      homedir.mockImplementationOnce(() => directory.path);
      vi.stubEnv(
        'XDG_CONFIG_HOME',
        selection === 'config' ? directory.path : undefined,
      );

      expect(await readLocalCredential('sprites')).toBe('generated-secret');
      expect(runLocal.mock.calls).toEqual([]);
    },
  );

  it('should treat a non-string stored credential as absent', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-invalid-credential-'),
    );
    const path = join(directory.path, 'credentials.json');
    await writeFile(path, '{"sprites":42}', { mode: 0o600 });

    expect(
      await readLocalCredential('sprites', { backend: 'protected-file', path }),
    ).toBeUndefined();
  });

  it('should reject a relative selected store before accessing it', async () => {
    await expect(
      readLocalCredential('sprites', {
        backend: 'keychain',
        path: 'relative.keychain',
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'INPUT' }));

    expect(runLocal.mock.calls).toEqual([]);
  });
});

describe('fn:saveLocalCredential', () => {
  it.each([
    { name: 'default', location: undefined, suffix: '' },
    {
      name: 'selected',
      location: {
        backend: 'keychain',
        path: '/generated/test.keychain',
      } satisfies CredentialStoreLocation,
      suffix: ' "/generated/test.keychain"',
    },
  ])(
    'should verify a write to the $name keychain before reporting success',
    async ({ location, suffix }) => {
      const result = await saveLocalCredential('sprites', 'generated-secret', {
        consent: true,
        allowProtectedFileFallback: false,
        ...(location ? { location } : {}),
      });

      expect(result).toEqual({ storage: 'keychain' });
      expect(sendLocalInput.mock.calls).toEqual([
        [
          {
            program: '/usr/bin/security',
            arguments: ['-i'],
            input: `add-generic-password -U -s "open-agent" -a "sprites" -w "generated-secret"${suffix}\n`,
            verifyResultExternally: true,
          },
        ],
      ]);
      expect(runLocal.mock.calls).toEqual([
        [
          {
            program: '/usr/bin/security',
            arguments: [
              'find-generic-password',
              '-s',
              'open-agent',
              '-a',
              'sprites',
              '-w',
              ...(location ? [location.path] : []),
            ],
            trimOutput: false,
          },
        ],
      ]);
    },
  );

  it('should refuse an unverified keychain write when fallback was declined', async () => {
    runLocal.mockImplementationOnce(async () => 'different-secret\n');

    await expect(
      saveLocalCredential('sprites', 'generated-secret', {
        consent: true,
        allowProtectedFileFallback: false,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'PREFLIGHT',
        message: expect.stringContaining('could not be verified'),
      }),
    );
  });

  it('should refuse retention before sending a secret without consent', async () => {
    await expect(
      saveLocalCredential('sprites', 'generated-secret', {
        consent: false,
        allowProtectedFileFallback: true,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'INPUT' }));

    expect(sendLocalInput.mock.calls).toEqual([]);
  });

  it.each([
    {
      name: 'unsupported platform',
      os: 'linux',
      location: undefined,
      reason: 'unavailable on this platform',
    },
    {
      name: 'explicit protected store',
      os: 'darwin',
      location: {
        backend: 'protected-file',
        path: '/generated/vault',
      } satisfies CredentialStoreLocation,
      reason: 'OS credential storage failed',
    },
  ] as const)(
    'should refuse an unapproved fallback for $name',
    async ({ os, location, reason }) => {
      platform.mockImplementationOnce(() => os);

      await expect(
        saveLocalCredential('sprites', 'generated-secret', {
          consent: true,
          allowProtectedFileFallback: false,
          ...(location ? { location } : {}),
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'PREFLIGHT',
          message: expect.stringContaining(reason),
        }),
      );
    },
  );

  it('should require a selected file when the keychain has no fallback path', async () => {
    platform.mockImplementationOnce(() => 'linux');

    await expect(
      saveLocalCredential('sprites', 'generated-secret', {
        consent: true,
        allowProtectedFileFallback: true,
        location: { backend: 'keychain', path: '/generated/test.keychain' },
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'INPUT',
        message: expect.stringContaining('No protected credential file'),
      }),
    );
  });

  it('should report a verification failure when keychain transport fails', async () => {
    sendLocalInput.mockImplementationOnce(async () => {
      throw new Error('transport unavailable');
    });

    await expect(
      saveLocalCredential('sprites', 'generated-secret', {
        consent: true,
        allowProtectedFileFallback: false,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'PREFLIGHT',
        message: expect.stringContaining('could not be verified'),
      }),
    );
  });

  it('should refuse an oversized interactive keychain command before delivery', async () => {
    await expect(
      saveLocalCredential('sprites', 'x'.repeat(4096), {
        consent: true,
        allowProtectedFileFallback: false,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'PREFLIGHT',
        message: expect.stringContaining('cannot be stored safely'),
      }),
    );

    expect(sendLocalInput.mock.calls).toEqual([]);
  });

  it('should propagate a protected-file read failure rather than overwrite the store', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'oa-unreadable-vault-'),
    );
    const path = join(directory.path, 'credentials.json');
    await mkdir(path, { mode: 0o700 });

    await expect(
      saveLocalCredential('sprites', 'generated-secret', {
        consent: true,
        allowProtectedFileFallback: true,
        location: { backend: 'protected-file', path },
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'INPUT',
        message: expect.stringContaining('regular file'),
      }),
    );
  });
});
