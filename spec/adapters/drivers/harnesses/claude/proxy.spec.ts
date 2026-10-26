import { mkdtempDisposable, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import '#adapters/drivers/harnesses/claude';
import {
  claudeReadiness,
  inspectClaude,
} from '#adapters/drivers/harnesses/claude/inspection';
import { CLAUDE_SETTINGS } from '#adapters/drivers/harnesses/claude/paths';
import { proxyOwnershipPath } from '#adapters/drivers/harnesses/shared/proxy-ownership';
import { recordHub } from '#adapters/guest/hub';
import { AWAKE_COMMAND } from '#adapters/guest/platform/awake';
import { awakeHookCommand } from '#application/catalog/awake';

import { configureHarnesses } from '#application/catalog/harnesses';
import { registry } from '#composition/registry';

import { routeOf } from '../../../../mocks/proxy-route';

import {
  createFilesystemSprite,
  createNativeCommandExecutor,
  guestOf,
} from '../../../../mocks/sprites';

import type { GuestChannel } from '#application/ports/guest-channel';

/**
 * applies native configuration and work hooks the way the workstation does
 * @param guest target guest
 * @param params proxy routing to apply
 * @param params.proxy CLIProxyAPI route, or none to restore native authentication
 */
async function configureClaude(
  guest: GuestChannel,
  params: Pick<Parameters<typeof configureHarnesses>[1], 'proxy'>,
): Promise<void> {
  await configureHarnesses(guest, {
    drivers: [registry.harnesses.claude],
    proxy: params.proxy,
    hub: { record: recordHub },
    awakeHook: awakeHookCommand({ awakeCommand: AWAKE_COMMAND }),
  });
}

describe('Claude native configuration', () => {
  it('should install native hooks without proxy routing and preserve user authentication', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-claude-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();

    await configureClaude(guestOf(sprite), {});
    const base =
      await filesystem.readJSON<Record<string, unknown>>(CLAUDE_SETTINGS);
    await filesystem.writeJSON(CLAUDE_SETTINGS, {
      ...base,
      env: { ANTHROPIC_API_KEY: 'user-key', USER_ENV: 'retained' },
    });
    await configureClaude(guestOf(sprite), {});
    const configured: unknown = JSON.parse(
      await readFile(join(directory.path, CLAUDE_SETTINGS), 'utf8'),
    );

    expect(base).toMatchObject({ env: { DISABLE_AUTOUPDATER: '1' } });
    expect(configured).toMatchObject({
      env: {
        ANTHROPIC_API_KEY: 'user-key',
        USER_ENV: 'retained',
        DISABLE_AUTOUPDATER: '1',
      },
      hooks: base.hooks,
    });
    expect(configured).not.toHaveProperty('env.ANTHROPIC_BASE_URL');
    expect(configured).not.toHaveProperty('env.ANTHROPIC_AUTH_TOKEN');
    expect(await filesystem.exists(proxyOwnershipPath('claude'))).toBe(false);
  });

  it('should merge proxy routing and idempotent hooks while retaining unrelated JSON settings', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-claude-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();
    const unrelatedHook = {
      hooks: [{ type: 'command', command: 'user-command' }],
    };
    await filesystem.mkdir('/home/agent/.claude', { recursive: true });
    await filesystem.writeFile(
      CLAUDE_SETTINGS,
      JSON.stringify({
        permissions: { allow: ['Read'] },
        env: { USER_ENV: 'retained' },
        hooks: {
          UserPromptSubmit: [unrelatedHook],
          CustomEvent: [unrelatedHook],
        },
      }),
    );

    await configureClaude(guestOf(sprite), {
      proxy: routeOf('https://proxy.example/v1/', 'client-key'),
    });
    const first: unknown = JSON.parse(
      await readFile(join(directory.path, CLAUDE_SETTINGS), 'utf8'),
    );
    await configureClaude(guestOf(sprite), {
      proxy: routeOf('https://proxy.example/v1/', 'client-key'),
    });
    const repeated: unknown = JSON.parse(
      await readFile(join(directory.path, CLAUDE_SETTINGS), 'utf8'),
    );

    expect(first).toMatchObject({
      permissions: { allow: ['Read'] },
      env: {
        USER_ENV: 'retained',
        ANTHROPIC_BASE_URL: 'https://proxy.example',
        ANTHROPIC_AUTH_TOKEN: 'client-key',
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
        DISABLE_AUTOUPDATER: '1',
      },
      hooks: {
        UserPromptSubmit: [
          unrelatedHook,
          {
            hooks: [
              {
                type: 'command',
                command:
                  '/opt/open-agent/governor/awake.sh hold-open --source claude --session - --budget-ms 8000',
                timeout: 10,
              },
            ],
          },
        ],
        CustomEvent: [unrelatedHook],
      },
    });
    expect(repeated).toEqual(first);
    expect(
      (await stat(join(directory.path, CLAUDE_SETTINGS))).mode & 0o777,
    ).toBe(0o600);
  });

  it('should restore earlier proxy values on disable and preserve later user changes', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-claude-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();
    await filesystem.mkdir('/home/agent/.claude', { recursive: true });
    await filesystem.writeFile(
      CLAUDE_SETTINGS,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://previous.example',
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '0',
          USER_ENV: 'retained',
        },
      }),
    );

    await configureClaude(guestOf(sprite), {
      proxy: routeOf('https://proxy.example', 'client-key'),
    });
    await configureClaude(guestOf(sprite), {});
    const restored: unknown = JSON.parse(
      await readFile(join(directory.path, CLAUDE_SETTINGS), 'utf8'),
    );

    expect(restored).toMatchObject({
      env: {
        ANTHROPIC_BASE_URL: 'https://previous.example',
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '0',
        USER_ENV: 'retained',
        DISABLE_AUTOUPDATER: '1',
      },
    });
    expect(await filesystem.exists(proxyOwnershipPath('claude'))).toBe(false);

    await configureClaude(guestOf(sprite), {
      proxy: routeOf('https://proxy.example', 'client-key'),
    });
    const managed =
      await filesystem.readJSON<Record<string, unknown>>(CLAUDE_SETTINGS);
    await filesystem.writeJSON(CLAUDE_SETTINGS, {
      ...managed,
      env: {
        ...(managed.env as Record<string, unknown>),
        ANTHROPIC_BASE_URL: 'https://user-change.example',
      },
    });
    await configureClaude(guestOf(sprite), {});
    const preserved: unknown = JSON.parse(
      await readFile(join(directory.path, CLAUDE_SETTINGS), 'utf8'),
    );

    expect(preserved).toMatchObject({
      env: {
        ANTHROPIC_BASE_URL: 'https://user-change.example',
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '0',
        USER_ENV: 'retained',
      },
    });
    expect(preserved).not.toHaveProperty('env.ANTHROPIC_AUTH_TOKEN');
  });

  it('should reject competing native authentication without rewriting it', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-claude-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();

    await filesystem.mkdir('/home/agent/.claude', { recursive: true });
    const conflict = JSON.stringify({ env: { ANTHROPIC_API_KEY: 'user-key' } });
    await filesystem.writeFile(CLAUDE_SETTINGS, conflict);

    await expect(
      configureClaude(guestOf(sprite), {
        proxy: routeOf('https://proxy.example', 'client-key'),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'CONFLICT',
        message: expect.not.stringContaining('user-key'),
      }),
    );
    expect(await readFile(join(directory.path, CLAUDE_SETTINGS), 'utf8')).toBe(
      conflict,
    );
  });

  it.each([
    ['invalid JSON', '{private-body', true],
    ['non-object JSON', '[]', false],
  ])(
    'should reject %s without rewriting native settings',
    async (_reason, source, hasCause) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-claude-'),
      );
      const sprite = createFilesystemSprite({ root: directory.path });
      const filesystem = sprite.filesystem();
      await filesystem.mkdir('/home/agent/.claude', { recursive: true });

      await filesystem.writeFile(CLAUDE_SETTINGS, source);

      await expect(configureClaude(guestOf(sprite), {})).rejects.toEqual(
        expect.objectContaining({
          code: 'INPUT',
          ...(hasCause
            ? {
                cause: expect.any(SyntaxError),
                causeVisibility: 'private',
                message: expect.not.stringContaining('private-body'),
              }
            : {}),
        }),
      );
      expect(
        await readFile(join(directory.path, CLAUDE_SETTINGS), 'utf8'),
      ).toBe(source);
    },
  );

  it.each([
    ['container', null],
    ['event array', { Stop: {} }],
  ])(
    'should reject malformed native hook %s without rewriting existing settings',
    async (_reason, hooks) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-claude-hooks-'),
      );
      const sprite = createFilesystemSprite({ root: directory.path });
      await sprite
        .filesystem()
        .mkdir('/home/agent/.claude', { recursive: true });
      const original = JSON.stringify({ hooks, userSetting: 'retained' });
      await sprite.filesystem().writeFile(CLAUDE_SETTINGS, original);

      await expect(configureClaude(guestOf(sprite), {})).rejects.toEqual(
        expect.objectContaining({ code: 'INPUT' }),
      );
      expect(
        await readFile(join(directory.path, CLAUDE_SETTINGS), 'utf8'),
      ).toBe(original);
    },
  );

  it('should report every awake hook as installed after configuration and as failed once one is removed', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-claude-hooks-'),
    );
    const inventory = {
      argv: ['claude', 'plugin', 'list', '--json'],
      result: { stdout: '[]', stderr: '', exitCode: 0 },
    };
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: createNativeCommandExecutor([inventory, inventory]),
    });
    const filesystem = sprite.filesystem();
    const readiness = async (): Promise<unknown> => {
      const { configuration } = await inspectClaude(guestOf(sprite));

      return {
        installed: configuration.awakeHooksInstalled,
        finding: claudeReadiness(configuration, { proxy: false }).find(
          ({ name }) => name === 'Claude awake hooks',
        ),
      };
    };

    await configureClaude(guestOf(sprite), {});
    expect(await readiness()).toEqual({
      installed: true,
      finding: { name: 'Claude awake hooks', status: 'passed' },
    });

    const settings =
      await filesystem.readJSON<Record<string, Record<string, unknown>>>(
        CLAUDE_SETTINGS,
      );
    const { PreToolUse: _removed, ...remaining } = settings.hooks!;
    await filesystem.writeJSON(CLAUDE_SETTINGS, {
      ...settings,
      hooks: remaining,
    });
    expect(await readiness()).toEqual({
      installed: false,
      finding: { name: 'Claude awake hooks', status: 'failed' },
    });
  });
});
