import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CLAUDE_PLUGIN_STATE } from '#drivers/harnesses/claude/paths';
import { claudePlugins } from '#drivers/harnesses/claude/plugins';

import {
  createFilesystemSprite,
  createNativeCommandExecutor,
  guestOf,
} from '../../../mocks/sprites';

import type { NativeCommandResponse } from '../../../mocks/sprites';

const applyClaudePlugins = claudePlugins.apply;
const success = { stdout: '{}', stderr: '', exitCode: 0 };
const emptyActions = {
  marketplaces: [],
  plugins: [],
  removeMarketplaces: [],
  disablePlugins: [],
  uninstallPlugins: [],
};
const marketplaceList = ['claude', 'plugin', 'marketplace', 'list', '--json'];
const pluginList = ['claude', 'plugin', 'list', '--json'];
const nativeOptions = ['--scope', 'user', '--json'];

/**
 * one expected native result from the SDK command boundary
 * @param argv native command argument vector
 * @param stdout native command standard output
 * @returns command and expected completion
 */
function nativeResponse(argv: string[], stdout = '{}'): NativeCommandResponse {
  return { argv, result: { ...success, stdout } };
}

/** one independently observable native reconciliation behavior */
interface ClaudePluginScenario {
  title: string;
  actions: Parameters<typeof applyClaudePlugins>[1];
  initialMarketplaces?: Array<Record<string, unknown>>;
  currentMarketplaces?: Array<Record<string, unknown>>;
  initialPlugins?: Array<{ id: string; enabled: boolean }>;
  finalPlugins?: Array<{ id: string; enabled: boolean }>;
  addedMarketplaces?: string[];
  changedPlugins?: Array<[string, string]>;
  removedMarketplaces?: string[];
  previousSelection?: string[];
  expectedSelection: string[];
}

describe('fn:applyClaudePlugins', () => {
  it.each([
    {
      title:
        'add each absent marketplace once while retaining an equivalent existing source',
      actions: {
        ...emptyActions,
        marketplaces: ['owner/existing', 'owner/new', 'owner/new'],
      },
      initialMarketplaces: [
        {
          name: 'existing-market',
          repo: 'https://github.com/owner/existing.git',
        },
      ],
      currentMarketplaces: [
        { name: 'existing-market', repo: 'owner/existing' },
        { name: 'new-market', repo: 'owner/new' },
      ],
      addedMarketplaces: ['owner/new'],
      expectedSelection: [],
    },
    {
      title:
        'enable a disabled selected plugin once while retaining enabled selections',
      actions: {
        ...emptyActions,
        plugins: ['enabled@market', 'disabled@market', 'disabled@market'],
      },
      initialPlugins: [
        { id: 'enabled@market', enabled: true },
        { id: 'disabled@market', enabled: false },
      ],
      finalPlugins: [
        { id: 'enabled@market', enabled: true },
        { id: 'disabled@market', enabled: true },
      ],
      changedPlugins: [['enable', 'disabled@market']],
      expectedSelection: ['enabled@market', 'disabled@market'],
    },
    {
      title: 'install and enable a new selected plugin once',
      actions: { ...emptyActions, plugins: ['new@market', 'new@market'] },
      finalPlugins: [{ id: 'new@market', enabled: true }],
      changedPlugins: [
        ['install', 'new@market'],
        ['enable', 'new@market'],
      ],
      expectedSelection: ['new@market'],
    },
    {
      title:
        'disable only an installed enabled plugin and drop it from selection',
      actions: {
        ...emptyActions,
        disablePlugins: [
          'missing@market',
          'already-disabled@market',
          'disable@market',
          'disable@market',
        ],
      },
      initialPlugins: [
        { id: 'disable@market', enabled: true },
        { id: 'already-disabled@market', enabled: false },
        { id: 'keep@market', enabled: true },
      ],
      finalPlugins: [
        { id: 'disable@market', enabled: false },
        { id: 'already-disabled@market', enabled: false },
        { id: 'keep@market', enabled: true },
      ],
      changedPlugins: [['disable', 'disable@market']],
      previousSelection: ['disable@market', 'keep@market'],
      expectedSelection: ['keep@market'],
    },
    {
      title:
        'uninstall only an installed plugin and retain unrelated selection',
      actions: {
        ...emptyActions,
        uninstallPlugins: ['missing@market', 'remove@market', 'remove@market'],
      },
      initialPlugins: [
        { id: 'remove@market', enabled: true },
        { id: 'keep@market', enabled: true },
      ],
      finalPlugins: [{ id: 'keep@market', enabled: true }],
      changedPlugins: [['uninstall', 'remove@market']],
      previousSelection: ['remove@market', 'keep@market'],
      expectedSelection: ['keep@market'],
    },
    {
      title: 'remove a registered marketplace once and ignore absent names',
      actions: {
        ...emptyActions,
        removeMarketplaces: ['missing', 'existing-market', 'existing-market'],
      },
      initialMarketplaces: [
        { name: 'existing-market', repo: 'owner/existing' },
      ],
      removedMarketplaces: ['existing-market'],
      expectedSelection: [],
    },
  ] satisfies ClaudePluginScenario[])('should $title', async (scenario) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-claude-actions-'),
    );
    const responses = [
      nativeResponse(
        marketplaceList,
        JSON.stringify(scenario.initialMarketplaces ?? []),
      ),
      ...(scenario.addedMarketplaces ?? []).map((source) =>
        nativeResponse([
          'claude',
          'plugin',
          'marketplace',
          'add',
          source,
          ...nativeOptions,
        ]),
      ),
      nativeResponse(pluginList, JSON.stringify(scenario.initialPlugins ?? [])),
      ...(scenario.changedPlugins ?? []).map(([action, identity]) =>
        nativeResponse([
          'claude',
          'plugin',
          action,
          identity,
          ...nativeOptions,
        ]),
      ),
      nativeResponse(
        marketplaceList,
        JSON.stringify(
          scenario.currentMarketplaces ?? scenario.initialMarketplaces ?? [],
        ),
      ),
      ...(scenario.removedMarketplaces ?? []).map((name) =>
        nativeResponse([
          'claude',
          'plugin',
          'marketplace',
          'remove',
          name,
          ...nativeOptions,
        ]),
      ),
      nativeResponse(pluginList, JSON.stringify(scenario.finalPlugins ?? [])),
    ];
    const execute = createNativeCommandExecutor(responses);
    const sprite = createFilesystemSprite({ root: directory.path, execute });
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
    await sprite
      .filesystem()
      .writeJSON(CLAUDE_PLUGIN_STATE, scenario.previousSelection ?? []);

    await applyClaudePlugins(guestOf(sprite), scenario.actions);

    expect(
      vi
        .mocked(execute)
        .mock.calls.map(([, args]) => args?.slice(args.indexOf('claude'))),
    ).toEqual(responses.map(({ argv }) => argv));
    expect(
      JSON.parse(
        await readFile(join(directory.path, CLAUDE_PLUGIN_STATE), 'utf8'),
      ),
    ).toEqual(scenario.expectedSelection);
  });

  it('should accept the native already-in-goal-state result and persist the completed selection', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-claude-idempotence-'),
    );
    const execute = createNativeCommandExecutor([
      {
        argv: ['claude', 'plugin', 'marketplace', 'list', '--json'],
        result: { stdout: '[]', stderr: '', exitCode: 0 },
      },
      {
        argv: [
          'claude',
          'plugin',
          'marketplace',
          'add',
          'owner/new',
          '--scope',
          'user',
          '--json',
        ],
        result: {
          stdout: '{"alreadyInGoalState":true}',
          stderr: '',
          exitCode: 1,
        },
      },
      {
        argv: ['claude', 'plugin', 'list', '--json'],
        result: { stdout: '[]', stderr: '', exitCode: 0 },
      },
      {
        argv: ['claude', 'plugin', 'marketplace', 'list', '--json'],
        result: { stdout: '[]', stderr: '', exitCode: 0 },
      },
      {
        argv: ['claude', 'plugin', 'list', '--json'],
        result: { stdout: '[]', stderr: '', exitCode: 0 },
      },
    ]);
    const sprite = createFilesystemSprite({ root: directory.path, execute });
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });

    await applyClaudePlugins(guestOf(sprite), {
      marketplaces: ['owner/new'],
      plugins: [],
      removeMarketplaces: [],
      disablePlugins: [],
      uninstallPlugins: [],
    });

    expect(
      JSON.parse(
        await readFile(join(directory.path, CLAUDE_PLUGIN_STATE), 'utf8'),
      ),
    ).toEqual([]);
  });

  it('should stop unsuccessful native mutations and retain the existing selection for invalid or negative JSON results', async () => {
    for (const stdout of ['not-json', '{}']) {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-claude-failure-'),
      );
      const execute = createNativeCommandExecutor([
        {
          argv: ['claude', 'plugin', 'marketplace', 'list', '--json'],
          result: { stdout: '[]', stderr: '', exitCode: 0 },
        },
        {
          argv: [
            'claude',
            'plugin',
            'marketplace',
            'add',
            'owner/new',
            '--scope',
            'user',
            '--json',
          ],
          result: { stdout, stderr: 'private diagnostic', exitCode: 1 },
        },
      ]);
      const sprite = createFilesystemSprite({ root: directory.path, execute });
      await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
      await sprite
        .filesystem()
        .writeJSON(CLAUDE_PLUGIN_STATE, ['previous@market']);

      await expect(
        applyClaudePlugins(guestOf(sprite), {
          marketplaces: ['owner/new'],
          plugins: [],
          removeMarketplaces: [],
          disablePlugins: [],
          uninstallPlugins: [],
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'PROVIDER',
          message: expect.stringContaining('status 1'),
        }),
      );
      expect(
        JSON.parse(
          await readFile(join(directory.path, CLAUDE_PLUGIN_STATE), 'utf8'),
        ),
      ).toEqual(['previous@market']);
    }
  });
});
