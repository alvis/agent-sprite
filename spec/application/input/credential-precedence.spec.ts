import { chmod, mkdtempDisposable, stat, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  readLocalCredential,
  saveLocalCredential,
} from '#adapters/host/credentials';
import { resolveBaseInputs } from '#application/input/base';
import { resolveProviderCredential } from '#application/input/provider-credential';

import { redactResolved } from '#kernel/redaction';

import { TAILSCALE_PROFILE } from '../../fixtures/profile';

import { dependencies } from '../../mocks/dependencies';

import type { CredentialStoreLocation } from '#domain/credentials';

const emptySources = { processEnv: {}, fileEnv: {}, profile: {} };

describe('fn:management credential precedence', () => {
  it.each([
    { name: 'malformed JSON', content: '{', mode: 0o600 },
    { name: 'broad permissions', content: '{"sprites":"stored"}', mode: 0o644 },
  ])(
    'should fail when a $name protected store is selected, but bypasses it for higher sources',
    async ({ content, mode }) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-credential-precedence-'),
      );
      const path = join(directory.path, 'credentials.json');
      const secretPath = join(directory.path, 'explicit-token');
      const location = {
        backend: 'protected-file',
        path,
      } satisfies CredentialStoreLocation;
      await writeFile(path, content, { mode });
      await chmod(path, mode);
      await writeFile(secretPath, 'file-selected-token\n', { mode: 0o600 });
      vi.stubEnv('OPEN_AGENT_CREDENTIAL_REFERENCE', 'env-selected-token');
      vi.stubEnv('SPRITES_TOKEN', undefined);

      await expect(readLocalCredential('sprites', location)).rejects.toEqual(
        expect.objectContaining({ code: 'INPUT' }),
      );
      await expect(
        resolveProviderCredential(dependencies, {
          options: {},
          provider: 'sprite',
          selection: {
            credentialStore: location,
          },
        }),
      ).rejects.toEqual(expect.objectContaining({ code: 'INPUT' }));
      await expect(
        resolveBaseInputs(dependencies, {
          options: {},
          sources: emptySources,
          selection: {
            credentialStore: location,
          },
        }),
      ).rejects.toEqual(expect.objectContaining({ code: 'INPUT' }));

      expect(
        await resolveProviderCredential(dependencies, {
          options: {},
          provider: 'sprite',
          selection: {
            reference: 'env:OPEN_AGENT_CREDENTIAL_REFERENCE',
            credentialStore: location,
          },
        }),
      ).toEqual({
        token: 'env-selected-token',
        source: '--provider-token-source env:OPEN_AGENT_CREDENTIAL_REFERENCE',
      });
      expect(
        (
          await resolveProviderCredential(dependencies, {
            options: {},
            provider: 'sprite',
            selection: {
              reference: `file:${secretPath}`,
              credentialStore: location,
            },
          })
        ).token,
      ).toBe('file-selected-token');
      vi.stubEnv('SPRITES_TOKEN', 'process-selected-token');
      expect(
        await resolveProviderCredential(dependencies, {
          options: {},
          provider: 'sprite',
          selection: {
            credentialStore: location,
          },
        }),
      ).toEqual({
        token: 'process-selected-token',
        source: 'SPRITES_TOKEN in the process environment',
      });

      const direct = await resolveBaseInputs(dependencies, {
        options: {},
        sources: {
          ...emptySources,
          processEnv: { SPRITES_TOKEN: 'process-selected-token' },
        },
        selection: { credentialStore: location },
      });
      expect(direct.input.providerToken).toBe('process-selected-token');
      const referenced = await resolveBaseInputs(dependencies, {
        options: { providerTokenSource: `file:${secretPath}` },
        sources: emptySources,
        selection: { credentialStore: location },
      });
      expect(referenced.input.providerToken).toBe('file-selected-token');
    },
  );

  it('should prefer the selected env file over the process environment for credentials and values', async () => {
    const sources = {
      ...emptySources,
      processEnv: {
        SPRITES_TOKEN: 'process-selected-token',
        CLIPROXYAPI_BASE_URL: 'https://process.example.test',
      },
      fileEnv: {
        SPRITES_TOKEN: 'file-selected-token',
        CLIPROXYAPI_BASE_URL: 'https://file.example.test',
      },
    };

    const credential = await resolveProviderCredential(dependencies, {
      options: { envFile: 'selected.env', localCredentials: false },
      provider: 'sprite',
      selection: { sources },
    });
    const { input } = await resolveBaseInputs(dependencies, {
      options: {
        envFile: 'selected.env',
        localCredentials: false,
        github: false,
      },
      sources,
    });

    expect(credential).toEqual({
      token: 'file-selected-token',
      source: 'SPRITES_TOKEN in selected.env',
    });
    expect(input).toMatchObject({
      providerToken: 'file-selected-token',
      proxyUrl: 'https://file.example.test',
      sources: { CLIPROXYAPI_BASE_URL: 'selected.env' },
    });
  });

  it('should read the Tailscale store only for selected enrollment and honors a direct key first', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tailnet-store-'),
    );
    const path = join(directory.path, 'credentials.json');
    const location = {
      backend: 'protected-file',
      path,
    } satisfies CredentialStoreLocation;
    await writeFile(path, '{', { mode: 0o600 });

    const unused = await resolveBaseInputs(dependencies, {
      options: { github: false },
      sources: {
        ...emptySources,
        processEnv: { SPRITES_TOKEN: 'provider-token' },
      },
      selection: { networkEnrollment: false, credentialStore: location },
    });
    expect(unused.input.networkKey).toBeUndefined();

    const direct = await resolveBaseInputs(dependencies, {
      options: { github: false },
      sources: {
        ...emptySources,
        processEnv: {
          SPRITES_TOKEN: 'provider-token',
          TAILSCALE_API_KEY: 'selected-key',
        },
      },
      selection: {
        profile: TAILSCALE_PROFILE,
        networkEnrollment: true,
        credentialStore: location,
      },
    });
    expect(direct.input.networkKey).toBe('selected-key');

    await expect(
      resolveBaseInputs(dependencies, {
        options: { github: false },
        sources: {
          ...emptySources,
          processEnv: { SPRITES_TOKEN: 'provider-token' },
        },
        selection: {
          profile: TAILSCALE_PROFILE,
          networkEnrollment: true,
          credentialStore: location,
        },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'INPUT' }));
  });

  it('should use a generated absent Keychain location without touching the default Keychain', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-absent-keychain-'),
    );
    const location = {
      backend: 'keychain',
      path: join(directory.path, 'absent.keychain-db'),
    } satisfies CredentialStoreLocation;

    expect(await readLocalCredential('sprites', location)).toBeUndefined();
    expect(
      await resolveProviderCredential(dependencies, {
        options: {},
        provider: 'sprite',
        selection: {
          credentialStore: location,
        },
      }),
    ).toEqual({});
    await expect(
      saveLocalCredential('sprites', 'secret', {
        consent: false,
        allowProtectedFileFallback: false,
        location,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'INPUT',
        message: expect.stringContaining('explicit consent'),
      }),
    );
  });

  it('should report the actual protected-file backend and retains private file and directory modes', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-protected-save-'),
    );
    const vault = join(directory.path, 'vault');
    const path = join(vault, 'credentials.json');
    const location = {
      backend: 'protected-file',
      path,
    } satisfies CredentialStoreLocation;
    const secret = 'generated-protected-credential-value';

    const saved = await saveLocalCredential('sprites', secret, {
      consent: true,
      allowProtectedFileFallback: true,
      location,
    });

    expect(saved).toEqual({
      storage: 'protected-file',
      fallbackReason: undefined,
    });
    expect((await stat(vault)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readLocalCredential('sprites', location)).toBe(secret);
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(redactResolved(`saved ${secret}`)).toBe('saved [REDACTED]');
  });

  it('should report a safe fallback reason before any Keychain command can accept unsafe input', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-credential-fallback-'),
    );
    const vault = join(directory.path, 'vault');
    const path = join(vault, 'credentials.json');
    const secret = 'generated\nunsafe-keychain-line';
    const location = {
      backend: 'keychain',
      path: join(directory.path, 'absent.keychain-db'),
      fallbackFilePath: path,
    } satisfies CredentialStoreLocation;

    const saved = await saveLocalCredential('tailscale', secret, {
      consent: true,
      allowProtectedFileFallback: true,
      location,
    });

    expect(saved).toEqual({
      storage: 'protected-file',
      fallbackReason:
        platform() === 'darwin'
          ? 'Keychain input cannot be stored safely'
          : 'Keychain is unavailable on this platform',
    });
    expect((await stat(vault)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(
      await readLocalCredential('tailscale', {
        backend: 'protected-file',
        path,
      }),
    ).toBe(secret);
    expect(JSON.stringify(saved)).not.toContain(secret);
  });
});
