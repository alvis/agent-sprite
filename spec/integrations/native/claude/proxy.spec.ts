import { mkdtempDisposable, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { configureClaude } from '#integrations/native/claude';
import { CLAUDE_SETTINGS } from '#integrations/native/configuration';
import { CLAUDE_PROXY_OWNERSHIP } from '#integrations/native/proxy-ownership';

import { createFilesystemSprite } from '../../../mocks/sprites.js';

describe('fn:configureClaude', () => {
  it('should install native hooks without proxy routing and preserve user authentication', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-claude-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();

    await configureClaude(sprite);
    const base =
      await filesystem.readJSON<Record<string, unknown>>(CLAUDE_SETTINGS);
    await filesystem.writeJSON(CLAUDE_SETTINGS, {
      ...base,
      env: { ANTHROPIC_API_KEY: 'user-key', USER_ENV: 'retained' },
    });
    await configureClaude(sprite);
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
    expect(await filesystem.exists(CLAUDE_PROXY_OWNERSHIP)).toBe(false);
  });

  it('should merge proxy routing and idempotent hooks while retaining unrelated JSON settings', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-claude-'),
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

    await configureClaude(sprite, 'https://proxy.example/v1/', 'client-key');
    const first: unknown = JSON.parse(
      await readFile(join(directory.path, CLAUDE_SETTINGS), 'utf8'),
    );
    await configureClaude(sprite, 'https://proxy.example/v1/', 'client-key');
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
                  '/opt/agent-sprite/node/bin/node /opt/agent-sprite/guest-task-hold.js hook acquire claude',
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
      join(tmpdir(), 'agent-sprite-claude-'),
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

    await configureClaude(sprite, 'https://proxy.example', 'client-key');
    await configureClaude(sprite);
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
    expect(await filesystem.exists(CLAUDE_PROXY_OWNERSHIP)).toBe(false);

    await configureClaude(sprite, 'https://proxy.example', 'client-key');
    const managed =
      await filesystem.readJSON<Record<string, unknown>>(CLAUDE_SETTINGS);
    await filesystem.writeJSON(CLAUDE_SETTINGS, {
      ...managed,
      env: {
        ...(managed.env as Record<string, unknown>),
        ANTHROPIC_BASE_URL: 'https://user-change.example',
      },
    });
    await configureClaude(sprite);
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

  it.each([
    ['missing key', 'https://proxy.example', undefined],
    ['missing URL', '', 'client-key'],
  ])(
    'should reject %s before creating native settings',
    async (_reason, url, key) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'agent-sprite-claude-'),
      );
      const sprite = createFilesystemSprite({ root: directory.path });
      const filesystem = sprite.filesystem();

      await expect(configureClaude(sprite, url, key)).rejects.toEqual(
        expect.objectContaining({ code: 'INPUT' }),
      );
      expect(await filesystem.exists(CLAUDE_SETTINGS)).toBe(false);
    },
  );

  it('should reject competing native authentication without rewriting it', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-claude-'),
    );
    const sprite = createFilesystemSprite({ root: directory.path });
    const filesystem = sprite.filesystem();

    await filesystem.mkdir('/home/agent/.claude', { recursive: true });
    const conflict = JSON.stringify({ env: { ANTHROPIC_API_KEY: 'user-key' } });
    await filesystem.writeFile(CLAUDE_SETTINGS, conflict);

    await expect(
      configureClaude(sprite, 'https://proxy.example', 'client-key'),
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
        join(tmpdir(), 'agent-sprite-claude-'),
      );
      const sprite = createFilesystemSprite({ root: directory.path });
      const filesystem = sprite.filesystem();
      await filesystem.mkdir('/home/agent/.claude', { recursive: true });

      await filesystem.writeFile(CLAUDE_SETTINGS, source);

      await expect(configureClaude(sprite)).rejects.toEqual(
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
        join(tmpdir(), 'agent-sprite-claude-hooks-'),
      );
      const sprite = createFilesystemSprite({ root: directory.path });
      await sprite
        .filesystem()
        .mkdir('/home/agent/.claude', { recursive: true });
      const original = JSON.stringify({ hooks, userSetting: 'retained' });
      await sprite.filesystem().writeFile(CLAUDE_SETTINGS, original);

      await expect(configureClaude(sprite)).rejects.toEqual(
        expect.objectContaining({ code: 'INPUT' }),
      );
      expect(
        await readFile(join(directory.path, CLAUDE_SETTINGS), 'utf8'),
      ).toBe(original);
    },
  );
});
