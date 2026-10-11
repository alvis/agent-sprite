import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse, stringify } from 'smol-toml';
import { describe, expect, it, vi } from 'vitest';

import { applyCodexPlugins } from '#integrations/native/codex';
import {
  CODEX_CONFIG,
  CODEX_PLUGIN_STATE,
} from '#integrations/native/configuration';

import {
  createFilesystemSprite,
  createNativeCommandExecutor,
} from '../../mocks/sprites.js';

const success = { stdout: '{}', stderr: '', exitCode: 0 };

describe('fn:applyCodexPlugins', () => {
  it('should reject Codex nonzero marketplace results even when native JSON claims goal state', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-codex-marketplace-failure-'),
    );
    const execute = vi.fn(
      createNativeCommandExecutor([
        {
          argv: ['codex', 'plugin', 'marketplace', 'list', '--json'],
          result: { stdout: '{"marketplaces":[]}', stderr: '', exitCode: 0 },
        },
        {
          argv: [
            'codex',
            'plugin',
            'marketplace',
            'add',
            'owner/new',
            '--json',
          ],
          result: {
            stdout: '{"alreadyInGoalState":true}',
            stderr: '',
            exitCode: 1,
          },
        },
        {
          argv: ['codex', 'plugin', 'list', '--json'],
          result: { stdout: '{"installed":[]}', stderr: '', exitCode: 0 },
        },
        {
          argv: ['codex', 'plugin', 'marketplace', 'list', '--json'],
          result: { stdout: '{"marketplaces":[]}', stderr: '', exitCode: 0 },
        },
        {
          argv: ['codex', 'plugin', 'list', '--json'],
          result: { stdout: '{"installed":[]}', stderr: '', exitCode: 0 },
        },
      ]),
    );
    const sprite = createFilesystemSprite({ root: directory.path, execute });
    const selection = JSON.stringify(['previous@market']);
    await sprite.filesystem().mkdir('/opt/agent-sprite', { recursive: true });
    await sprite.filesystem().writeFile(CODEX_PLUGIN_STATE, selection);

    await expect(
      applyCodexPlugins(sprite, {
        marketplaces: ['owner/new'],
        plugins: [],
        removeMarketplaces: [],
        disablePlugins: [],
        uninstallPlugins: [],
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'PROVIDER' }));

    expect(
      await readFile(join(directory.path, CODEX_PLUGIN_STATE), 'utf8'),
    ).toBe(selection);
    expect(
      execute.mock.calls.filter(([, args]) => args?.includes('codex')),
    ).toHaveLength(2);
  });

  it('should reconcile requested marketplaces and native plugins while preserving unrelated TOML and selection state', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-codex-actions-'),
    );
    const execute = createNativeCommandExecutor([
      {
        argv: ['codex', 'plugin', 'marketplace', 'list', '--json'],
        result: {
          stdout: JSON.stringify({
            marketplaces: [
              {
                name: 'existing-market',
                marketplaceSource: { source: 'owner/existing' },
              },
            ],
          }),
          stderr: '',
          exitCode: 0,
        },
      },
      {
        argv: ['codex', 'plugin', 'marketplace', 'add', 'owner/new', '--json'],
        result: success,
      },
      {
        argv: ['codex', 'plugin', 'list', '--json'],
        result: {
          stdout: JSON.stringify({
            installed: [
              { pluginId: 'existing@market', enabled: true },
              { pluginId: 'remove@market', enabled: true },
              { pluginId: 'disable@market', enabled: true },
            ],
          }),
          stderr: '',
          exitCode: 0,
        },
      },
      {
        argv: ['codex', 'plugin', 'add', 'new@market', '--json'],
        result: success,
      },
      {
        argv: ['codex', 'plugin', 'remove', 'remove@market', '--json'],
        result: success,
      },
      {
        argv: ['codex', 'plugin', 'marketplace', 'list', '--json'],
        result: {
          stdout: JSON.stringify({
            marketplaces: [
              {
                name: 'existing-market',
                marketplaceSource: { source: 'owner/existing' },
              },
              {
                name: 'new-market',
                marketplaceSource: { source: 'owner/new' },
              },
            ],
          }),
          stderr: '',
          exitCode: 0,
        },
      },
      {
        argv: [
          'codex',
          'plugin',
          'marketplace',
          'remove',
          'existing-market',
          '--json',
        ],
        result: success,
      },
      {
        argv: ['codex', 'plugin', 'list', '--json'],
        result: {
          stdout: JSON.stringify({
            installed: [
              { pluginId: 'existing@market', enabled: true },
              { pluginId: 'new@market', enabled: true },
              { pluginId: 'disable@market', enabled: false },
              { pluginId: 'unrelated@market', enabled: true },
            ],
          }),
          stderr: '',
          exitCode: 0,
        },
      },
    ]);
    const sprite = createFilesystemSprite({ root: directory.path, execute });
    const filesystem = sprite.filesystem();
    const prior = {
      model: 'user-model',
      plugins: {
        'existing@market': { enabled: false, userField: 'retained' },
        'new@market': 'legacy',
        'disable@market': { enabled: true, userField: 'retained' },
        'absent-disable@market': 'legacy',
        'unrelated@market': { enabled: false },
      },
    };
    await filesystem.mkdir('/opt/agent-sprite', { recursive: true });
    await filesystem.mkdir('/home/agent/.codex', { recursive: true });
    await filesystem.writeFile(CODEX_CONFIG, stringify(prior));
    await filesystem.writeJSON(CODEX_PLUGIN_STATE, [
      'remove@market',
      'disable@market',
    ]);

    await applyCodexPlugins(sprite, {
      marketplaces: ['owner/existing', 'owner/new', 'owner/new'],
      plugins: ['existing@market', 'new@market', 'new@market'],
      removeMarketplaces: ['missing', 'existing-market', 'existing-market'],
      disablePlugins: [
        'disable@market',
        'absent-disable@market',
        'missing@market',
      ],
      uninstallPlugins: ['missing@market', 'remove@market', 'remove@market'],
    });

    expect(
      parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
    ).toEqual({
      model: 'user-model',
      plugins: {
        'existing@market': { enabled: true, userField: 'retained' },
        'new@market': { enabled: true },
        'disable@market': { enabled: false, userField: 'retained' },
        'absent-disable@market': { enabled: false },
        'missing@market': { enabled: false },
        'unrelated@market': { enabled: false },
      },
    });
    expect(
      JSON.parse(
        await readFile(join(directory.path, CODEX_PLUGIN_STATE), 'utf8'),
      ),
    ).toEqual(['existing@market', 'new@market']);
  });

  it('should create disable-only configuration and leave it intact when no plugin changes are requested', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-codex-disable-'),
    );
    const listings = [
      {
        argv: ['codex', 'plugin', 'marketplace', 'list', '--json'],
        result: { stdout: '{"marketplaces":[]}', stderr: '', exitCode: 0 },
      },
      {
        argv: ['codex', 'plugin', 'list', '--json'],
        result: { stdout: '{"installed":[]}', stderr: '', exitCode: 0 },
      },
      {
        argv: ['codex', 'plugin', 'marketplace', 'list', '--json'],
        result: { stdout: '{"marketplaces":[]}', stderr: '', exitCode: 0 },
      },
      {
        argv: ['codex', 'plugin', 'list', '--json'],
        result: { stdout: '{"installed":[]}', stderr: '', exitCode: 0 },
      },
    ];
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: createNativeCommandExecutor([...listings, ...listings]),
    });
    await sprite.filesystem().mkdir('/opt/agent-sprite', { recursive: true });
    await sprite.filesystem().mkdir('/home/agent/.codex', { recursive: true });
    const empty = {
      marketplaces: [],
      plugins: [],
      removeMarketplaces: [],
      disablePlugins: [],
      uninstallPlugins: [],
    };

    await applyCodexPlugins(sprite, {
      ...empty,
      disablePlugins: ['disabled@market'],
    });
    await applyCodexPlugins(sprite, empty);

    expect(
      parse(await readFile(join(directory.path, CODEX_CONFIG), 'utf8')),
    ).toEqual({ plugins: { 'disabled@market': { enabled: false } } });
    expect(
      JSON.parse(
        await readFile(join(directory.path, CODEX_PLUGIN_STATE), 'utf8'),
      ),
    ).toEqual([]);
  });
});
