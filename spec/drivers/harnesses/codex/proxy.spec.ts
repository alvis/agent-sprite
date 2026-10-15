import { mkdtempDisposable, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse, stringify } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import { configureHarnesses } from '#core/harnesses';
import { codex } from '#drivers/harnesses/codex/index';
import { codexReadiness, inspectCodex } from '#drivers/harnesses/codex/inspect';
import {
  CODEX_CONFIG,
  CODEX_HOOKS,
  CODEX_TOKEN,
} from '#drivers/harnesses/codex/paths';
import { proxyOwnershipPath } from '#drivers/harnesses/shared/proxy-ownership';

import {
  createFilesystemSprite,
  createNativeCommandExecutor,
  guestOf,
} from '../../../mocks/sprites.js';

import type { ProxyRoute } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

/**
 * applies native configuration and work hooks the way the workstation does
 * @param guest target guest
 * @param params proxy routing to apply
 * @param params.proxy CLIProxyAPI route, or none to restore native authentication
 */
async function configureCodex(
  guest: GuestChannel,
  params: { proxy?: ProxyRoute },
): Promise<void> {
  await configureHarnesses(guest, { drivers: [codex], proxy: params.proxy });
}

describe('driver:codex native configuration', () => {
  it('should preserve unrelated TOML tables and native hooks while configuring the supported Responses provider', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-codex-'),
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

    await configureCodex(guestOf(sprite), {
      proxy: { url: 'https://proxy.example/v1/', apiKey: 'client-key' },
    });
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
                  '/opt/open-agent/bin/open-agent-awake hold-close --source codex --session - --budget-ms 8000',
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
      join(tmpdir(), 'open-agent-codex-'),
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

    await configureCodex(guestOf(sprite), {
      proxy: { url: 'https://proxy.example', apiKey: 'client-key' },
    });
    await configureCodex(guestOf(sprite), {
      proxy: { url: 'https://proxy.example', apiKey: 'rotated-client-key' },
    });
    await configureCodex(guestOf(sprite), {});

    expect(
      parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
    ).toEqual(prior);
    expect(await readFile(join(directory.path, CODEX_TOKEN), 'utf8')).toBe(
      'previous-token\n',
    );
    expect(await filesystem.exists(proxyOwnershipPath('codex'))).toBe(false);
  });

  it('should remove newly owned routing and retain user replacements without requiring a proxy for native hooks', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-codex-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();

    await configureCodex(guestOf(sprite), {});

    expect(await filesystem.exists(CODEX_CONFIG)).toBe(false);
    expect(await filesystem.exists('/home/agent/.codex/hooks.json')).toBe(true);

    await configureCodex(guestOf(sprite), {
      proxy: { url: 'https://proxy.example', apiKey: 'client-key' },
    });
    await configureCodex(guestOf(sprite), {});

    expect(
      parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
    ).toEqual({});
    expect(await filesystem.exists(CODEX_TOKEN)).toBe(false);

    await configureCodex(guestOf(sprite), {
      proxy: { url: 'https://proxy.example', apiKey: 'client-key' },
    });
    const replacement = {
      model_provider: 'user-provider',
      model_providers: {
        cliproxyapi: { base_url: 'https://user-change.example' },
      },
      features: { unrelated: true },
    };
    await filesystem.writeFile(CODEX_CONFIG, stringify(replacement));
    await filesystem.writeFile(CODEX_TOKEN, 'user-token\n');
    await configureCodex(guestOf(sprite), {});

    expect(
      parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
    ).toEqual(replacement);
    expect(await readFile(join(directory.path, CODEX_TOKEN), 'utf8')).toBe(
      'user-token\n',
    );
  });

  it.each([
    ['env_key', { env_key: 'USER_KEY' }],
    ['bearer token', { experimental_bearer_token: 'user-token' }],
  ])(
    'should reject competing %s authentication without rewriting it',
    async (_reason, authentication) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-codex-'),
      );
      const sprite = createFilesystemSprite({ root: directory.path });
      const filesystem = sprite.filesystem();

      await filesystem.mkdir('/home/agent/.codex', { recursive: true });
      const conflict = stringify({
        model_providers: { cliproxyapi: authentication },
      });
      await filesystem.writeFile(CODEX_CONFIG, conflict);

      await expect(
        configureCodex(guestOf(sprite), {
          proxy: { url: 'https://proxy.example', apiKey: 'client-key' },
        }),
      ).rejects.toEqual(expect.objectContaining({ code: 'CONFLICT' }));
      expect(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')).toBe(
        conflict,
      );
      expect(await filesystem.exists(CODEX_TOKEN)).toBe(false);
    },
  );

  it('should reject malformed TOML without rewriting it', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-codex-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();
    await filesystem.mkdir('/home/agent/.codex', { recursive: true });

    await filesystem.writeFile(CODEX_CONFIG, '[unterminated');

    await expect(configureCodex(guestOf(sprite), {})).rejects.toEqual(
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
      join(tmpdir(), 'open-agent-codex-containers-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();
    const prior = {
      model_providers: { cliproxyapi: { auth: {} } },
      features: {},
    };
    await filesystem.mkdir('/home/agent/.codex', { recursive: true });
    await filesystem.writeFile(CODEX_CONFIG, stringify(prior));

    await configureCodex(guestOf(sprite), {
      proxy: { url: 'https://proxy.example', apiKey: 'client-key' },
    });
    await configureCodex(guestOf(sprite), {});

    expect(
      parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
    ).toEqual(prior);

    await configureCodex(guestOf(sprite), {
      proxy: { url: 'https://proxy.example', apiKey: 'client-key' },
    });
    const userReplacement = {
      model_providers: { other: { name: 'User provider' } },
      features: false,
    };
    await filesystem.writeFile(CODEX_CONFIG, stringify(userReplacement));
    await configureCodex(guestOf(sprite), {});

    expect(
      parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
    ).toEqual(userReplacement);
  });

  it('should preserve an existing provider registry and user replacement of the entire registry during disable', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-codex-registry-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();
    await filesystem.mkdir('/home/agent/.codex', { recursive: true });

    for (const registry of [{}, { other: { name: 'User provider' } }]) {
      const prior = { model_providers: registry };
      await filesystem.writeFile(CODEX_CONFIG, stringify(prior));

      await configureCodex(guestOf(sprite), {
        proxy: { url: 'https://proxy.example', apiKey: 'client-key' },
      });
      await configureCodex(guestOf(sprite), {});

      expect(
        parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
      ).toEqual(prior);
    }

    await configureCodex(guestOf(sprite), {
      proxy: { url: 'https://proxy.example', apiKey: 'client-key' },
    });
    const replacement = { model_providers: 'user-managed-registry' };
    await filesystem.writeFile(CODEX_CONFIG, stringify(replacement));
    await configureCodex(guestOf(sprite), {});

    expect(
      parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
    ).toEqual(replacement);
  });

  it('should capture user replacements on reconfiguration and preserve deliberate token removal on disable', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-codex-reconfigure-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();
    await configureCodex(guestOf(sprite), {
      proxy: { url: 'https://proxy.example', apiKey: 'first-key' },
    });
    const replacement = { model_provider: 'user-provider' };
    await filesystem.writeFile(CODEX_CONFIG, stringify(replacement));
    await filesystem.writeFile(CODEX_TOKEN, 'user-token\n');

    await configureCodex(guestOf(sprite), {
      proxy: { url: 'https://next-proxy.example', apiKey: 'next-key' },
    });
    await rm(join(directory.path, CODEX_TOKEN));
    await configureCodex(guestOf(sprite), {});

    expect(
      parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
    ).toEqual(replacement);
    expect(await filesystem.exists(CODEX_TOKEN)).toBe(false);
  });

  it('should report every awake hook as installed after configuration and as failed once one is removed', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-codex-hooks-'),
    );
    const inventory = {
      argv: ['codex', 'plugin', 'list', '--json'],
      result: { stdout: '[]', stderr: '', exitCode: 0 },
    };
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: createNativeCommandExecutor([inventory, inventory]),
    });
    const filesystem = sprite.filesystem();
    const readiness = async (): Promise<unknown> => {
      const { configuration } = await inspectCodex(guestOf(sprite));

      return {
        installed: configuration.awakeHooksInstalled,
        finding: codexReadiness(configuration, { proxy: false }).find(
          ({ name }) => name === 'Codex awake hooks',
        ),
      };
    };

    await configureCodex(guestOf(sprite), {});
    expect(await readiness()).toEqual({
      installed: true,
      finding: { name: 'Codex awake hooks', status: 'passed' },
    });

    const settings =
      await filesystem.readJSON<Record<string, Record<string, unknown>>>(
        CODEX_HOOKS,
      );
    const { Interrupt: _removed, ...remaining } = settings.hooks!;
    await filesystem.writeJSON(CODEX_HOOKS, { ...settings, hooks: remaining });
    expect(await readiness()).toEqual({
      installed: false,
      finding: { name: 'Codex awake hooks', status: 'failed' },
    });
  });
});
