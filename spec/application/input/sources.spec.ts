import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  readInputSources,
  readSetupFile,
  resolveSecret,
  runtimeEnvironment,
} from '#application/input/sources';
import { redactResolved } from '#kernel/redaction';

import { dependencies } from '../../mocks/dependencies';

describe('fn:readInputSources', () => {
  it('should parse the selected dotenv file and keep only non-secret profile inputs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-agent-input-'));
    vi.stubEnv('HOME', directory);
    vi.stubEnv('SPRITES_TOKEN', 'process-secret-for-source-test');
    const profileDirectory = join(directory, '.config', 'open-agent');
    const envPath = join(directory, 'chosen.env');
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(
      join(profileDirectory, 'profile.json'),
      JSON.stringify({
        TAILSCALE_TAILNET: 'profile-tailnet',
        TAILSCALE_EXIT_NODE: 'profile-exit',
        CLIPROXYAPI_BASE_URL: 'https://profile.example.test',
        SPRITES_TOKEN: 'profile-secret-must-be-ignored',
        GH_TOKEN: 'profile-github-must-be-ignored',
        GIT_AUTHOR_NAME: 'profile-identity-must-be-ignored',
        EXTRA: 'profile-runtime-must-be-ignored',
        OTHER: 123,
      }),
    );
    await writeFile(
      envPath,
      'export SPRITES_TOKEN="file secret"\nRUNTIME_VALUE="value # retained" # comment\nMULTILINE="first\\nsecond"\n',
    );

    try {
      const sources = await readInputSources(dependencies, {
        credentialFile: envPath,
      });

      expect({
        fileEnv: sources.fileEnv,
        profile: sources.profile,
        token: sources.processEnv.SPRITES_TOKEN,
      }).toEqual({
        fileEnv: {
          SPRITES_TOKEN: 'file secret',
          RUNTIME_VALUE: 'value # retained',
          MULTILINE: 'first\nsecond',
        },
        profile: {
          TAILSCALE_TAILNET: 'profile-tailnet',
          TAILSCALE_EXIT_NODE: 'profile-exit',
          CLIPROXYAPI_BASE_URL: 'https://profile.example.test',
        },
        token: 'process-secret-for-source-test',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should tolerate an absent profile and reject malformed or unreadable profiles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-agent-profile-'));
    vi.stubEnv('HOME', directory);
    const profilePath = join(
      directory,
      '.config',
      'open-agent',
      'profile.json',
    );

    try {
      const sources = await readInputSources(dependencies, {});
      expect({ fileEnv: sources.fileEnv, profile: sources.profile }).toEqual({
        fileEnv: {},
        profile: {},
      });
      await mkdir(join(directory, '.config', 'open-agent'), {
        recursive: true,
      });
      for (const profile of [null, [], 'text']) {
        await writeFile(profilePath, JSON.stringify(profile));
        await expect(readInputSources(dependencies, {})).rejects.toEqual(
          expect.objectContaining({ code: 'INPUT' }),
        );
      }
      await rm(profilePath);
      await mkdir(profilePath);
      await expect(readInputSources(dependencies, {})).rejects.toEqual(
        expect.objectContaining({ code: 'INPUT' }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('fn:runtimeEnvironment', () => {
  it('should forward dotenv runtime inputs while retaining management and CLI inputs locally', () => {
    const runtime = runtimeEnvironment(dependencies, {
      SPRITES_TOKEN: 'sprites-management',
      TAILSCALE_API_KEY: 'tailscale-management',
      TAILSCALE_AUTH_KEY: 'transient-enrollment',
      OPEN_AGENT_NETWORK: 'tailscale',
      OPEN_AGENT_IDLE_MINUTES: '0',
      CLIPROXYAPI_API_KEY: 'native-proxy-client',
      GH_TOKEN: 'native-github-client',
      GIT_AUTHOR_NAME: 'Author',
      CI: 'true',
      APP_ACCESS_TOKEN: 'runtime-app-secret',
      APP_DESCRIPTION: 'runtime setting',
    });

    expect(runtime).toEqual({
      APP_ACCESS_TOKEN: 'runtime-app-secret',
      APP_DESCRIPTION: 'runtime setting',
    });
    expect(redactResolved('runtime-app-secret remains private')).toBe(
      '[REDACTED] remains private',
    );
  });

  it('should reject process startup, loader, Git, and proxy overrides as a group', () => {
    expect(() =>
      runtimeEnvironment(dependencies, {
        NODE_OPTIONS: '--import unwanted.mjs',
        HTTP_PROXY: 'http://unwanted.test',
        DYLD_INSERT_LIBRARIES: '/unwanted',
        GIT_CONFIG_COUNT: '1',
        npm_config_cache: '/unwanted',
      }),
    ).toThrow(expect.objectContaining({ code: 'INPUT' }));
  });
});

describe('fn:resolveSecret', () => {
  it('should use explicit environment and file references ahead of fallback values', async () => {
    vi.stubEnv('OPEN_AGENT_TEST_SECRET', 'environment-selected-secret');
    const directory = await mkdtemp(join(tmpdir(), 'open-agent-secret-'));
    const path = join(directory, 'secret');
    await writeFile(path, ' file-selected-secret\n\n');

    try {
      const values = [
        await resolveSecret(dependencies, undefined, 'fallback-secret'),
        await resolveSecret(dependencies, undefined, ''),
        await resolveSecret(
          dependencies,
          'env:OPEN_AGENT_TEST_SECRET',
          'fallback-secret',
        ),
        await resolveSecret(dependencies, `file:${path}`, 'fallback-secret'),
      ];

      expect(values).toEqual([
        'fallback-secret',
        undefined,
        'environment-selected-secret',
        ' file-selected-secret',
      ]);
      expect(
        redactResolved(
          'fallback-secret environment-selected-secret  file-selected-secret',
        ),
      ).toBe('[REDACTED] [REDACTED] [REDACTED]');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should reject empty or malformed explicit references instead of falling back', async () => {
    vi.stubEnv('OPEN_AGENT_EMPTY_SECRET', '');
    const directory = await mkdtemp(join(tmpdir(), 'open-agent-empty-secret-'));
    const path = join(directory, 'secret');
    await writeFile(path, '\n');

    try {
      await expect(
        resolveSecret(
          dependencies,
          'env:OPEN_AGENT_EMPTY_SECRET',
          'fallback-secret',
        ),
      ).rejects.toEqual(expect.objectContaining({ code: 'INPUT' }));
      await expect(
        resolveSecret(dependencies, `file:${path}`, 'fallback-secret'),
      ).rejects.toEqual(expect.objectContaining({ code: 'INPUT' }));
      await expect(
        resolveSecret(dependencies, 'keychain:', 'fallback-secret'),
      ).rejects.toEqual(expect.objectContaining({ code: 'INPUT' }));
      await expect(
        resolveSecret(dependencies, 'keychain:service', 'fallback-secret'),
      ).rejects.toEqual(expect.objectContaining({ code: 'INPUT' }));
      await expect(
        resolveSecret(
          dependencies,
          'literal-secret-is-not-a-reference',
          'fallback-secret',
        ),
      ).rejects.toEqual(expect.objectContaining({ code: 'INPUT' }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('fn:readSetupFile', () => {
  it('should return the file bytes unchanged', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-agent-setup-file-'));
    const path = join(directory, 'setup.sh');
    const bytes = Buffer.from([0x23, 0x21, 0x00, 0xff, 0x0a]);
    await writeFile(path, bytes);

    try {
      await expect(readSetupFile(dependencies, path)).resolves.toEqual(bytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should refuse an empty file with an input fault', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-agent-setup-file-'));
    const path = join(directory, 'empty.sh');
    await writeFile(path, '');

    try {
      await expect(readSetupFile(dependencies, path)).rejects.toMatchObject({
        code: 'INPUT',
        message: expect.stringContaining('is empty'),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('input source failures', () => {
  it('should select and redact a keychain secret through the host boundary', async () => {
    const run = vi.fn<typeof dependencies.host.run>(
      async () => 'keychain-secret',
    );
    const host = {
      ...dependencies.host,
      run,
    } satisfies typeof dependencies.host;

    await expect(
      resolveSecret({ host }, 'keychain:service/account', 'fallback'),
    ).resolves.toBe('keychain-secret');
    expect(run.mock.calls).toEqual([
      [
        {
          program: 'security',
          arguments: [
            'find-generic-password',
            '-s',
            'service',
            '-a',
            'account',
            '-w',
          ],
        },
      ],
    ]);
    expect(redactResolved('keychain-secret')).toBe('[REDACTED]');
  });

  it('should classify an unreadable keychain secret as an input fault', async () => {
    const host = {
      ...dependencies.host,
      run: vi.fn<typeof dependencies.host.run>(async () => {
        throw new Error('keychain unavailable');
      }),
    } satisfies typeof dependencies.host;

    await expect(
      resolveSecret({ host }, 'keychain:service/account', 'fallback'),
    ).rejects.toMatchObject({
      code: 'INPUT',
      message: expect.stringContaining('keychain'),
    });
  });

  it('should classify an unreadable setup file as a private input fault', async () => {
    const host = {
      ...dependencies.host,
      readInputBytes: vi.fn<typeof dependencies.host.readInputBytes>(
        async () => {
          throw new Error('private file contents');
        },
      ),
    } satisfies typeof dependencies.host;

    await expect(
      readSetupFile({ host }, '/selected-setup'),
    ).rejects.toMatchObject({ code: 'INPUT', causeVisibility: 'private' });
  });

  it('should reject malformed profile JSON', async () => {
    const host = {
      ...dependencies.host,
      readInputFile: vi.fn<typeof dependencies.host.readInputFile>(
        async () => '{',
      ),
    } satisfies typeof dependencies.host;

    await expect(
      readInputSources({ ...dependencies, host }, {}),
    ).rejects.toMatchObject({
      code: 'INPUT',
      message: expect.stringContaining('JSON'),
    });
  });
});
