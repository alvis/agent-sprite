import { mkdtempDisposable, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse, stringify } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import { configureCodex } from '#integrations/native/codex';
import { CODEX_CONFIG, CODEX_TOKEN } from '#integrations/native/configuration';
import { CODEX_PROXY_OWNERSHIP } from '#integrations/native/proxy-ownership';

import { createFilesystemSprite } from '../../../mocks/sprites.js';

describe('fn:configureCodex', () => {
  it('should preserve unrelated TOML tables and native hooks while configuring the supported Responses provider', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-codex-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();
    const prior = {
      model: 'user-model',
      model_provider: 'openai',
      features: { unrelated: true },
      model_providers: {
        other: { name: 'Other provider', base_url: 'https://other.example' },
        cliproxyapi: {
          request_max_retries: 3,
          auth: { user_field: 'retained' },
        },
      },
      projects: { '/work': { trust_level: 'trusted' } },
    };
    const userHook = { hooks: [{ type: 'command', command: 'user-command' }] };
    await filesystem.mkdir('/home/agent/.codex', { recursive: true });
    await filesystem.writeFile(CODEX_CONFIG, stringify(prior));
    await filesystem.writeJSON('/home/agent/.codex/hooks.json', {
      customSetting: 'retained',
      hooks: { Stop: [userHook] },
    });

    await configureCodex(sprite, 'https://proxy.example/v1/', 'client-key');
    const configured = parse(
      await readFile(join(directory.path, CODEX_CONFIG), 'utf8'),
    );
    const hooks: unknown = JSON.parse(
      await readFile(
        join(directory.path, '/home/agent/.codex/hooks.json'),
        'utf8',
      ),
    );

    expect(configured).toEqual({
      ...prior,
      model_provider: 'cliproxyapi',
      features: { ...prior.features, api_key_model_discovery: true },
      model_providers: {
        ...prior.model_providers,
        cliproxyapi: {
          request_max_retries: 3,
          name: 'CLIProxyAPI',
          base_url: 'https://proxy.example/v1',
          wire_api: 'responses',
          model_catalog_url: 'https://proxy.example/v1/models',
          auth: {
            user_field: 'retained',
            command: '/usr/bin/cat',
            args: [CODEX_TOKEN],
            timeout_ms: 5_000,
          },
        },
      },
    });
    expect(hooks).toMatchObject({
      customSetting: 'retained',
      hooks: {
        Stop: [
          userHook,
          {
            hooks: [
              {
                type: 'command',
                command:
                  '/opt/agent-sprite/node/bin/node /opt/agent-sprite/guest-task-hold.js hook release codex',
                timeout: 10,
              },
            ],
          },
        ],
      },
    });
    expect(await readFile(join(directory.path, CODEX_TOKEN), 'utf8')).toBe(
      'client-key\n',
    );
    expect((await stat(join(directory.path, CODEX_TOKEN))).mode & 0o777).toBe(
      0o600,
    );
  });

  it('should restore the previous provider and private token when managed proxy routing is disabled', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-codex-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();
    const prior = {
      model: 'user-model',
      model_provider: 'openai',
      features: { api_key_model_discovery: false, unrelated: true },
      model_providers: {
        other: { name: 'Other' },
        cliproxyapi: {
          name: 'Previous',
          base_url: 'https://previous.example',
          wire_api: 'chat',
          model_catalog_url: 'https://previous.example/models',
          auth: {
            command: 'previous-command',
            args: ['previous-argument'],
            timeout_ms: 10,
            user_field: 'retained',
          },
        },
      },
    };
    await filesystem.mkdir('/home/agent/.codex', { recursive: true });
    await filesystem.writeFile(CODEX_CONFIG, stringify(prior));
    await filesystem.writeFile(CODEX_TOKEN, 'previous-token\n');

    await configureCodex(sprite, 'https://proxy.example', 'client-key');
    await configureCodex(sprite, 'https://proxy.example', 'rotated-client-key');
    await configureCodex(sprite);

    expect(
      parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
    ).toEqual(prior);
    expect(await readFile(join(directory.path, CODEX_TOKEN), 'utf8')).toBe(
      'previous-token\n',
    );
    expect(await filesystem.exists(CODEX_PROXY_OWNERSHIP)).toBe(false);
  });

  it('should remove newly owned routing and retain user replacements without requiring a proxy for native hooks', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-codex-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();

    await configureCodex(sprite);

    expect(await filesystem.exists(CODEX_CONFIG)).toBe(false);
    expect(await filesystem.exists('/home/agent/.codex/hooks.json')).toBe(true);

    await configureCodex(sprite, 'https://proxy.example', 'client-key');
    await configureCodex(sprite);

    expect(
      parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
    ).toEqual({});
    expect(await filesystem.exists(CODEX_TOKEN)).toBe(false);

    await configureCodex(sprite, 'https://proxy.example', 'client-key');
    const replacement = {
      model_provider: 'user-provider',
      model_providers: {
        cliproxyapi: { base_url: 'https://user-change.example' },
      },
      features: { unrelated: true },
    };
    await filesystem.writeFile(CODEX_CONFIG, stringify(replacement));
    await filesystem.writeFile(CODEX_TOKEN, 'user-token\n');
    await configureCodex(sprite);

    expect(
      parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
    ).toEqual(replacement);
    expect(await readFile(join(directory.path, CODEX_TOKEN), 'utf8')).toBe(
      'user-token\n',
    );
  });

  it.each([
    ['missing key', 'https://proxy.example', undefined],
    ['missing URL', '', 'client-key'],
  ])(
    'should reject %s before creating native settings',
    async (_reason, url, key) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'agent-sprite-codex-'),
      );
      const sprite = createFilesystemSprite({ root: directory.path });
      const filesystem = sprite.filesystem();

      await expect(configureCodex(sprite, url, key)).rejects.toEqual(
        expect.objectContaining({ code: 'INPUT' }),
      );
      expect(await filesystem.exists(CODEX_CONFIG)).toBe(false);
    },
  );

  it.each([
    ['env_key', { env_key: 'USER_KEY' }],
    ['bearer token', { experimental_bearer_token: 'user-token' }],
  ])(
    'should reject competing %s authentication without rewriting it',
    async (_reason, authentication) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'agent-sprite-codex-'),
      );
      const sprite = createFilesystemSprite({ root: directory.path });
      const filesystem = sprite.filesystem();

      await filesystem.mkdir('/home/agent/.codex', { recursive: true });
      const conflict = stringify({
        model_providers: { cliproxyapi: authentication },
      });
      await filesystem.writeFile(CODEX_CONFIG, conflict);

      await expect(
        configureCodex(sprite, 'https://proxy.example', 'client-key'),
      ).rejects.toEqual(expect.objectContaining({ code: 'CONFLICT' }));
      expect(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')).toBe(
        conflict,
      );
      expect(await filesystem.exists(CODEX_TOKEN)).toBe(false);
    },
  );

  it('should reject malformed TOML without rewriting it', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-codex-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();
    await filesystem.mkdir('/home/agent/.codex', { recursive: true });

    await filesystem.writeFile(CODEX_CONFIG, '[unterminated');

    await expect(configureCodex(sprite)).rejects.toEqual(
      expect.objectContaining({
        code: 'INPUT',
        cause: expect.any(Error),
        causeVisibility: 'private',
        message: expect.not.stringContaining('[unterminated'),
      }),
    );
    expect(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')).toBe(
      '[unterminated',
    );
  });

  it('should preserve pre-existing empty tables and later removal of the managed provider during disable', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-codex-containers-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();
    const prior = {
      model_providers: { cliproxyapi: { auth: {} } },
      features: {},
    };
    await filesystem.mkdir('/home/agent/.codex', { recursive: true });
    await filesystem.writeFile(CODEX_CONFIG, stringify(prior));

    await configureCodex(sprite, 'https://proxy.example', 'client-key');
    await configureCodex(sprite);

    expect(
      parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
    ).toEqual(prior);

    await configureCodex(sprite, 'https://proxy.example', 'client-key');
    const userReplacement = {
      model_providers: { other: { name: 'User provider' } },
      features: false,
    };
    await filesystem.writeFile(CODEX_CONFIG, stringify(userReplacement));
    await configureCodex(sprite);

    expect(
      parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
    ).toEqual(userReplacement);
  });

  it('should preserve an existing provider registry and user replacement of the entire registry during disable', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-codex-registry-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();
    await filesystem.mkdir('/home/agent/.codex', { recursive: true });

    for (const registry of [{}, { other: { name: 'User provider' } }]) {
      const prior = { model_providers: registry };
      await filesystem.writeFile(CODEX_CONFIG, stringify(prior));

      await configureCodex(sprite, 'https://proxy.example', 'client-key');
      await configureCodex(sprite);

      expect(
        parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
      ).toEqual(prior);
    }

    await configureCodex(sprite, 'https://proxy.example', 'client-key');
    const replacement = { model_providers: 'user-managed-registry' };
    await filesystem.writeFile(CODEX_CONFIG, stringify(replacement));
    await configureCodex(sprite);

    expect(
      parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
    ).toEqual(replacement);
  });

  it('should capture user replacements on reconfiguration and preserve deliberate token removal on disable', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-codex-reconfigure-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();
    await configureCodex(sprite, 'https://proxy.example', 'first-key');
    const replacement = { model_provider: 'user-provider' };
    await filesystem.writeFile(CODEX_CONFIG, stringify(replacement));
    await filesystem.writeFile(CODEX_TOKEN, 'user-token\n');

    await configureCodex(sprite, 'https://next-proxy.example', 'next-key');
    await rm(join(directory.path, CODEX_TOKEN));
    await configureCodex(sprite);

    expect(
      parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
    ).toEqual(replacement);
    expect(await filesystem.exists(CODEX_TOKEN)).toBe(false);
  });
});
