import { EventEmitter } from 'node:events';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { stringify } from 'smol-toml';
import { describe, expect, it, vi } from 'vitest';

import { inspectCodex } from '#adapters/drivers/harnesses/codex/inspection';
import {
  CODEX_CONFIG,
  CODEX_HOME,
  CODEX_PLUGIN_STATE,
} from '#adapters/drivers/harnesses/codex/paths';
import { HOME } from '#adapters/guest/platform/account';
import { isRecord } from '#kernel/guards';

import {
  createFilesystemSprite,
  createNativeCommandExecutor,
  guestOf,
} from '../../../../mocks/sprites';

import type { GuestProcess } from '#application/ports/guest-channel';

/**
 * answers native app-server requests on a guest transport stream
 * @param skillReply result of skills/list, or a server error
 * @returns the duplex guest process used by the real app-server client
 */
function skillProcess(
  skillReply: Record<string, unknown> | Error,
): GuestProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events = new EventEmitter();
  const process = Object.assign(events, {
    stdin,
    stdout,
    stderr,
    kill: (): void => {
      events.emit('exit', 0);
    },
  });
  stdin.on('data', (chunk: Buffer) => {
    const frame: unknown = JSON.parse(chunk.toString());
    if (!isRecord(frame)) {
      return;
    }
    if (frame.method === 'initialize') {
      stdout.write(`${JSON.stringify({ id: frame.id, result: {} })}\n`);
    }
    if (frame.method === 'skills/list') {
      stdout.write(
        `${JSON.stringify(
          skillReply instanceof Error
            ? { id: frame.id, error: { message: skillReply.message } }
            : { id: frame.id, result: skillReply },
        )}\n`,
      );
    }
  });
  stdin.on('finish', () => events.emit('exit', 0));

  return process;
}

describe('fn:inspectCodex', () => {
  it.each([
    {
      name: 'absent settings and native credentials',
      settings: undefined,
      authenticated: false,
      pluginListAvailable: true,
      configuration: {
        gatewayConfigured: false,
        modelDiscoveryEnabled: false,
        pluginListAvailable: true,
        awakeHooksInstalled: false,
        authentication: 'not-configured',
      },
    },
    {
      name: 'non-table provider and feature settings with native credentials',
      settings: {
        model_provider: 'cliproxyapi',
        model_providers: 'legacy',
        features: 'legacy',
      },
      authenticated: true,
      pluginListAvailable: false,
      configuration: {
        gatewayConfigured: false,
        modelDiscoveryEnabled: false,
        pluginListAvailable: false,
        awakeHooksInstalled: false,
        authentication: 'native',
      },
    },
    {
      name: 'a provider with a response wire API but no base URL',
      settings: {
        model_provider: 'cliproxyapi',
        model_providers: { cliproxyapi: { wire_api: 'responses' } },
        features: { api_key_model_discovery: true },
      },
      authenticated: false,
      pluginListAvailable: true,
      configuration: {
        gatewayConfigured: false,
        modelDiscoveryEnabled: false,
        pluginListAvailable: true,
        awakeHooksInstalled: false,
        authentication: 'not-configured',
      },
    },
    {
      name: 'complete managed proxy and model discovery settings',
      settings: {
        model_provider: 'cliproxyapi',
        model_providers: {
          cliproxyapi: {
            wire_api: 'responses',
            base_url: 'https://gateway.example',
            model_catalog_url: 'https://gateway.example/models',
          },
        },
        features: { api_key_model_discovery: true },
      },
      authenticated: true,
      pluginListAvailable: true,
      configuration: {
        gatewayConfigured: true,
        modelDiscoveryEnabled: true,
        pluginListAvailable: true,
        awakeHooksInstalled: false,
        authentication: 'managed-proxy',
      },
    },
  ])('should report $name from the guest configuration', async (scenario) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-codex-inspection-'),
    );
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: createNativeCommandExecutor([
        {
          argv: ['codex', 'plugin', 'list', '--json'],
          result: {
            stdout: '{"installed":[]}',
            stderr: '',
            exitCode: scenario.pluginListAvailable ? 0 : 1,
          },
        },
      ]),
    });
    const files = sprite.filesystem();
    if (scenario.settings) {
      await files.writeFile(CODEX_CONFIG, stringify(scenario.settings));
    }
    if (scenario.authenticated) {
      await files.writeFile(`${CODEX_HOME}/auth.json`, '{}');
    }

    const inspection = await inspectCodex(guestOf(sprite));

    expect(inspection).toEqual({
      configuration: scenario.configuration,
      selectedPlugins: [],
      pluginsEnabled: scenario.pluginListAvailable,
      evidence: undefined,
    });
  });

  it('should retain only skills from managed plugins in the agent workspace', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-codex-skills-'),
    );
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: createNativeCommandExecutor([
        {
          argv: ['codex', 'plugin', 'list', '--json'],
          result: {
            stdout:
              '{"installed":[{"pluginId":"managed@market","enabled":true}]}',
            stderr: '',
            exitCode: 0,
          },
        },
      ]),
    });
    await sprite.filesystem().writeJSON(CODEX_PLUGIN_STATE, ['managed@market']);
    const guest = guestOf(sprite);
    vi.spyOn(guest, 'spawn').mockImplementation(() =>
      skillProcess({
        data: [
          {
            cwd: HOME,
            skills: [
              null,
              { pluginId: 3, name: 'invalid', path: '/ignored', enabled: true },
              {
                pluginId: 'other@market',
                name: 'foreign',
                path: '/ignored',
                enabled: true,
              },
              {
                pluginId: 'managed@market',
                name: 'selected',
                path: '/home/agent/.codex/skills/selected',
                enabled: true,
              },
            ],
          },
        ],
      }),
    );

    const inspection = await inspectCodex(guest);

    expect(inspection).toEqual({
      configuration: {
        gatewayConfigured: false,
        modelDiscoveryEnabled: false,
        pluginListAvailable: true,
        awakeHooksInstalled: false,
        authentication: 'not-configured',
      },
      selectedPlugins: ['managed@market'],
      pluginsEnabled: true,
      evidence: {
        kind: 'skills',
        selected: ['managed@market'],
        skills: [
          {
            pluginId: 'managed@market',
            name: 'selected',
            path: '/home/agent/.codex/skills/selected',
            enabled: true,
          },
        ],
      },
    });
  });

  it.each([
    { name: 'a reply without workspaces', reply: { data: null } },
    {
      name: 'a reply without the agent workspace',
      reply: { data: [null, { cwd: '/another/workspace', skills: [] }] },
    },
    {
      name: 'a workspace without a skill list',
      reply: { data: [{ cwd: HOME, skills: null }] },
    },
    {
      name: 'a selected skill without a name',
      reply: {
        data: [
          {
            cwd: HOME,
            skills: [
              {
                pluginId: 'managed@market',
                path: '/home/agent/.codex/skills/invalid',
                enabled: true,
              },
            ],
          },
        ],
      },
    },
    {
      name: 'a selected skill without a path',
      reply: {
        data: [
          {
            cwd: HOME,
            skills: [
              { pluginId: 'managed@market', name: 'invalid', enabled: true },
            ],
          },
        ],
      },
    },
    {
      name: 'a selected skill without boolean enablement',
      reply: {
        data: [
          {
            cwd: HOME,
            skills: [
              {
                pluginId: 'managed@market',
                name: 'invalid',
                path: '/home/agent/.codex/skills/invalid',
                enabled: 'yes',
              },
            ],
          },
        ],
      },
    },
  ])('should reject $name as native skill evidence', async ({ reply }) => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-codex-skills-'),
    );
    const sprite = createFilesystemSprite({
      root: directory.path,
      execute: createNativeCommandExecutor([
        {
          argv: ['codex', 'plugin', 'list', '--json'],
          result: { stdout: '{"installed":[]}', stderr: '', exitCode: 0 },
        },
      ]),
    });
    await sprite.filesystem().writeJSON(CODEX_PLUGIN_STATE, ['managed@market']);
    const guest = guestOf(sprite);
    vi.spyOn(guest, 'spawn').mockImplementation(() => skillProcess(reply));

    const inspection = await inspectCodex(guest);

    expect(inspection.evidence).toBeUndefined();
  });
});
