import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { CLAUDE_WORK_HOOKS } from '#adapters/drivers/harnesses/claude/hooks';
import { CLAUDE_SETTINGS } from '#adapters/drivers/harnesses/claude/paths';
import { CODEX_WORK_HOOKS } from '#adapters/drivers/harnesses/codex/hooks';
import { CODEX_HOOKS } from '#adapters/drivers/harnesses/codex/paths';
import { mergeWorkHooks } from '#adapters/drivers/harnesses/shared/hooks';
import {
  MANAGED_LABEL,
  SCHEMA_LABEL,
  mergeMetadataLabels,
} from '#adapters/drivers/providers/sprite/labels';
import { AWAKE_COMMAND } from '#adapters/guest/platform/awake';
import { ENVIRONMENT_PATH } from '#adapters/guest/platform/layout';
import { awakeHookCommand } from '#application/catalog/awake';
import { doctorWorkstation, showWorkstation } from '#application/inspect';
import { runCommand } from '#application/workstation';
import { chooseWorkstationAction } from '#application/workstation/actions';
import { resultExitCode } from '#cli/exit';
import { prepareResult, writePreparedResult } from '#cli/output';
import { projectResult } from '#cli/output/project';
import { serializeResult } from '#cli/serialization';
import { summarizeProfile } from '#domain/recorded';

import { OperationContext } from '#kernel/operation';

import { rememberSecret } from '#kernel/redaction';

import { OPEN_AGENT_VERSION } from '#kernel/version';

import { environmentOf } from '../fixtures/environment';
import { driveInk } from '../fixtures/ink';
import { profileWith } from '../fixtures/profile';

import { dependencies } from '../mocks/dependencies';
import {
  createFilesystemSprite,
  providerOf,
  serveServiceRegistry,
  writtenPaths,
} from '../mocks/sprites';

import type { Sprite } from '@fly/sprites';

import type { Mock } from 'vitest';

import type { WorkHooks } from '#adapters/drivers/harnesses/shared/hooks';

import type { GuestExecute } from '../mocks/sprites';

// setup's root session is a framed guest shell only the live specs open
vi.mock(
  '#adapters/guest/platform/session/open',
  async () => import('../mocks/session'),
);

/** the profile the installed workstation recorded */
const PROFILE = profileWith({
  network: false,
  exitNode: false,
  cliproxyapi: false,
});

/**
 * creates a managed SDK boundary with one installed disposable workstation
 * @param root isolated guest filesystem root
 * @param ready whether the guest serves ready service and endpoint evidence
 * @returns provider client, managed Sprite and the guest's answer to every
 * command other than a file program
 */
async function installedSprite(
  root: string,
  ready = false,
): Promise<{
  client: SpritesClient;
  sprite: Sprite;
  execute: Mock<GuestExecute>;
}> {
  const client = new SpritesClient('test-org/1/0abc/0def');
  const agentEnvironment = {
    ok: true,
    serverVersion: '0.0.46-nightly.20261014.3118',
    orchestrationProtocolVersion: 2,
  };
  const execute = vi.fn<GuestExecute>(async (_file, args) => ({
    stdout:
      ready && args?.includes('/usr/bin/curl')
        ? `${JSON.stringify(agentEnvironment)}\n200`
        : '[]',
    stderr: '',
    exitCode: 0,
  }));
  const sprite = Object.assign(createFilesystemSprite({ root, execute }), {
    id: 'sprite-temporary',
    organizationName: 'test-org',
    // set up by this release, so a section run leaves its labels as they are
    labels: mergeMetadataLabels([MANAGED_LABEL, SCHEMA_LABEL], {
      setup: 'ready',
      profile: summarizeProfile(PROFILE),
      version: OPEN_AGENT_VERSION,
    }),
    url: 'https://temporary.sprites.app',
    status: 'running',
    listServices: vi.fn<Sprite['listServices']>(async () =>
      ready
        ? [
            {
              name: 't3-code',
              cmd: '/opt/open-agent/drivers/agents/t3/launcher.sh',
              args: [],
              needs: [],
              state: { name: 't3-code', status: 'running' },
            },
            {
              name: 'open-agent-cron',
              cmd: '/opt/open-agent/update-schedule',
              args: [],
              needs: [],
              state: { name: 'open-agent-cron', status: 'running' },
            },
          ]
        : [],
    ),
  });
  serveServiceRegistry(sprite);
  Object.assign(client, {
    listAllSprites: vi.fn<SpritesClient['listAllSprites']>(async () => [
      sprite,
    ]),
    getSprite: vi.fn<SpritesClient['getSprite']>(async () => sprite),
    deleteSprite: vi.fn<SpritesClient['deleteSprite']>(async () => undefined),
  });
  await sprite
    .filesystem()
    .writeFile(ENVIRONMENT_PATH, JSON.stringify(environmentOf(PROFILE)));

  return { client, sprite, execute };
}

/**
 * creates a managed SDK boundary whose guest mints one pairing code
 * @param root isolated guest filesystem root
 * @param pairingCode the code the agent's pairing command prints
 * @returns provider client and the guest's answer to every command other
 * than a file program
 */
async function managedSprite(
  root: string,
  pairingCode: string,
): Promise<{ client: SpritesClient; execute: Mock<GuestExecute> }> {
  const client = new SpritesClient('test-org/1/0abc/0def');
  const execute = vi.fn<GuestExecute>(async () => ({
    stdout: `Token: ${pairingCode}\nExpires: 2099-01-01T00:00:00Z\n`,
    stderr: '',
    exitCode: 0,
  }));
  const sprite = Object.assign(
    createFilesystemSprite({ root, name: 'primary', execute }),
    {
      id: 'sprite-primary',
      organizationName: 'test-org',
      labels: [MANAGED_LABEL, SCHEMA_LABEL],
      url: 'https://primary.sprites.app',
      status: 'running',
    },
  );
  Object.assign(client, {
    getSprite: vi.fn<SpritesClient['getSprite']>(async () => sprite),
  });
  // pairing reads the recorded agent from the guest environment
  await sprite
    .filesystem()
    .writeFile(ENVIRONMENT_PATH, JSON.stringify(environmentOf(PROFILE)));

  return { client, execute };
}

describe('cmd:show', () => {
  it('should serialize a non-Error SDK rejection as one redacted JSON failure', async () => {
    const privateRejection = 'sdk-private-rejection';
    rememberSecret(privateRejection);
    vi.stubEnv('SPRITES_TOKEN', 'test-org/1/0abc/0def');
    vi.spyOn(SpritesClient.prototype, 'getSprite').mockRejectedValueOnce(
      privateRejection,
    );
    const result = await runCommand(dependencies, {
      command: 'show',
      machine: 'primary',
      options: { json: true, nonInteractive: true, localCredentials: false },
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let json = '';
    let diagnostic = '';
    stdout.on('data', (chunk: Buffer) => {
      json += chunk.toString();
    });
    stderr.on('data', (chunk: Buffer) => {
      diagnostic += chunk.toString();
    });
    try {
      writePreparedResult(
        prepareResult({
          result,
          options: { json: true },
          streams: { stdout, stderr },
        }),
        { stdout, stderr },
      );
    } finally {
      stdout.destroy();
      stderr.destroy();
    }

    expect(result).toMatchObject({ command: 'show', ok: false });
    expect(json.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(json)).toMatchObject({
      schemaVersion: 1,
      command: 'show',
      ok: false,
      error: { code: 'UNEXPECTED', machine: 'primary' },
    });
    expect(json).not.toContain('sdk-private-rejection');
    expect(diagnostic).toBe('');
  });

  it('should report the executed menu action when its provider lookup fails', async () => {
    for (const [label, command] of [
      ['Configure a section', 'setup'],
      ['Permanently terminate', 'terminate'],
    ] as const) {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-action-failure-'),
      );
      const { client, sprite } = await installedSprite(directory.path);
      vi.mocked(client.getSprite)
        .mockResolvedValueOnce(sprite)
        .mockRejectedValueOnce(new Error('provider lookup unavailable'));

      const observed = await driveInk(
        async (interaction) =>
          chooseWorkstationAction(dependencies, {
            request: { command: 'show', machine: 'temporary', options: {} },
            provider: providerOf(client),
            interaction,
          }),
        [
          { waitFor: 'Workstation action', input: label },
          { waitFor: `Search: ${label}`, input: '\r' },
          ...(command === 'setup'
            ? [
                { waitFor: 'Choose setup section', input: 'Managed tools' },
                { waitFor: 'Search: Managed tools', input: '\r' },
              ]
            : []),
        ],
      );

      expect(observed.matchedSteps, observed.output).toBe(
        command === 'setup' ? 4 : 2,
      );
      expect(observed.result).toMatchObject({
        command,
        ok: false,
        error: {
          code: 'UNEXPECTED',
          machine: 'temporary',
          machineId: 'sprite-temporary',
        },
      });
      expect(client.deleteSprite).not.toHaveBeenCalled();
    }
  }, 15_000);

  it('should return a ready doctor result only from current service and environment endpoint evidence', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-doctor-ready-'),
    );
    const { client, sprite } = await installedSprite(directory.path, true);
    const hooks = (owned: WorkHooks): Record<string, unknown> =>
      mergeWorkHooks(
        {},
        { owned, command: awakeHookCommand({ awakeCommand: AWAKE_COMMAND }) },
      );
    await sprite.filesystem().mkdir('/home/agent/.claude', { recursive: true });
    await sprite.filesystem().mkdir('/home/agent/.codex', { recursive: true });
    await sprite
      .filesystem()
      .writeFile(
        CLAUDE_SETTINGS,
        JSON.stringify({ hooks: hooks(CLAUDE_WORK_HOOKS) }),
      );
    await sprite
      .filesystem()
      .writeFile(
        CODEX_HOOKS,
        JSON.stringify({ hooks: hooks(CODEX_WORK_HOOKS) }),
      );

    const result = await doctorWorkstation(dependencies, {
      provider: providerOf(client),
      requestedName: 'temporary',
    });

    expect(result).toMatchObject({
      command: 'doctor',
      ok: true,
      data: {
        currentReadiness: {
          ready: true,
          failures: [],
          services: expect.arrayContaining([
            { name: 't3-code', state: 'running' },
            { name: 'open-agent-cron', state: 'running' },
          ]),
          native: {
            agentEnvironment: {
              ok: true,
              serverVersion: '0.0.46-nightly.20261014.3118',
              orchestrationProtocolVersion: 2,
            },
          },
        },
      },
    });
    expect(serializeResult(projectResult(result))).toMatchObject({
      schemaVersion: 1,
      command: 'doctor',
      ok: true,
      data: { currentReadiness: { ready: true } },
    });
  });

  it('should return typed failed doctor readiness from a real guest inspection', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-doctor-'),
    );
    const { client } = await installedSprite(directory.path);

    const result = await doctorWorkstation(dependencies, {
      provider: providerOf(client),
      requestedName: 'temporary',
    });

    expect(result).toMatchObject({
      command: 'doctor',
      ok: false,
      error: {
        code: 'PREFLIGHT',
        machine: 'temporary',
        machineId: 'sprite-temporary',
      },
      data: {
        machine: { name: 'temporary', id: 'sprite-temporary' },
        currentReadiness: {
          ready: false,
          failures: expect.arrayContaining(['T3 service']),
          skipped: expect.arrayContaining([
            'private network',
            'CLIProxyAPI gateway',
          ]),
        },
      },
    });
    expect(serializeResult(projectResult(result))).toMatchObject({
      schemaVersion: 1,
      command: 'doctor',
      ok: false,
      data: { currentReadiness: { ready: false } },
    });
  });

  it('should report a failed service probe with sibling evidence in doctor and both output modes', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-doctor-probe-failure-'),
    );
    const { client, sprite } = await installedSprite(directory.path);
    const secret = 'cor02-service-private-token';
    rememberSecret(secret);
    vi.mocked(sprite.listServices).mockRejectedValue(
      new Error(`service list failed ${secret}`),
    );

    const result = await doctorWorkstation(dependencies, {
      provider: providerOf(client),
      requestedName: 'temporary',
    });
    expect(result).toMatchObject({
      command: 'doctor',
      ok: false,
      error: { code: 'PREFLIGHT', machineId: 'sprite-temporary' },
      data: {
        currentReadiness: {
          ready: false,
          failures: expect.arrayContaining(['services inspection unavailable']),
          probeFailures: [
            {
              probe: 'services',
              reason: 'Service registry response could not be read.',
            },
          ],
          network: { skipped: true },
          native: expect.any(Object),
        },
      },
    });

    for (const json of [false, true]) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let out = '';
      let errorOutput = '';
      stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      stderr.on('data', (chunk: Buffer) => {
        errorOutput += chunk.toString();
      });
      writePreparedResult(
        prepareResult({
          result,
          options: { json },
          streams: { stdout, stderr },
        }),
        { stdout, stderr },
      );
      stdout.destroy();
      stderr.destroy();
      expect(out + errorOutput).toContain('services');
      expect(out + errorOutput).not.toContain(secret);
      if (json) {
        expect(errorOutput).toBe('');
        expect(out.trim().split('\n')).toHaveLength(1);
        expect(JSON.parse(out)).toMatchObject({
          schemaVersion: 1,
          command: 'doctor',
          ok: false,
          error: { code: 'PREFLIGHT' },
          data: { currentReadiness: { ready: false } },
        });
      } else {
        expect(out).toBe('');
        expect(errorOutput.replaceAll(/\s+/g, ' ')).toContain(
          'Probe: services · Reason: Service registry response could not be read.',
        );
      }
    }
  });

  it('should keep failed native inspection visible in show --inspect', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-show-probe-failure-'),
    );
    const { client, execute } = await installedSprite(directory.path);
    execute.mockImplementation(async (_file, args) => {
      if (args?.includes('plugin') && args.includes('list')) {
        throw new Error('native SDK probe unavailable');
      }

      return { stdout: '[]', stderr: '', exitCode: 0 };
    });

    const result = await showWorkstation(dependencies, {
      request: {
        command: 'show',
        machine: 'temporary',
        options: { inspect: true },
      },
      provider: providerOf(client),
    });
    expect(result).toMatchObject({
      command: 'show',
      ok: true,
      data: {
        inspection: {
          probeFailures: [
            { probe: 'native', reason: 'native SDK probe unavailable' },
          ],
          readiness: {
            ready: false,
            failures: expect.arrayContaining(['native inspection unavailable']),
          },
        },
      },
    });
    expect(serializeResult(projectResult(result))).toMatchObject({
      data: { inspection: { probeFailures: [{ probe: 'native' }] } },
    });
  });

  it('should return cancellation exit 130 during a deferred doctor probe', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-doctor-cancel-'),
    );
    const { sprite } = await installedSprite(directory.path);
    const pending =
      Promise.withResolvers<Awaited<ReturnType<Sprite['listServices']>>>();
    vi.mocked(sprite.listServices).mockReturnValue(pending.promise);
    vi.spyOn(SpritesClient.prototype, 'getSprite').mockResolvedValue(sprite);
    vi.stubEnv('SPRITES_TOKEN', 'test-org/1/0abc/0def');
    const controller = new AbortController();
    const context = new OperationContext({ signal: controller.signal });
    try {
      const resultPromise = runCommand(
        dependencies,
        {
          command: 'doctor',
          machine: 'temporary',
          options: { nonInteractive: true, localCredentials: false },
        },
        { operation: context },
      );
      await vi.waitFor(() =>
        expect(sprite.listServices).toHaveBeenCalledOnce(),
      );
      controller.abort();
      const result = await resultPromise;
      expect(result).toMatchObject({
        command: 'doctor',
        ok: false,
        error: { code: 'CANCELLED', machineId: 'sprite-temporary' },
      });
      expect(resultExitCode(result)).toBe(130);
    } finally {
      pending.resolve([]);
    }
  });

  it('should not carry show --yes into termination after selecting a workstation', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-show-terminate-'),
    );
    const { client, execute } = await installedSprite(directory.path);

    const observed = await driveInk(
      async (interaction) =>
        chooseWorkstationAction(dependencies, {
          request: { command: 'show', options: { yes: true } },
          provider: providerOf(client),
          interaction,
        }),
      [
        { waitFor: 'Select a workstation', input: '\r' },
        { waitFor: 'Workstation action', input: 'Permanently terminate' },
        { waitFor: 'Search: Permanently terminate', input: '\r' },
        { waitFor: 'Type temporary to delete it', input: 'wrong-name' },
        { waitFor: 'wrong-name', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(5);
    expect(observed.result).toMatchObject({
      command: 'terminate',
      ok: false,
      error: { code: 'CANCELLED' },
    });
    expect(client.deleteSprite).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  }, 15_000);

  it('should not carry show consent into setup tools, and still navigates real sections', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-show-setup-'),
    );
    const { client, sprite, execute } = await installedSprite(directory.path);
    const observed = await driveInk(
      async (interaction) =>
        chooseWorkstationAction(dependencies, {
          request: {
            command: 'show',
            options: {
              yes: true,
              withPairCode: true,
              inspect: true,
              localCredentials: false,
              github: false,
            },
          },
          provider: providerOf(client),
          interaction,
        }),
      [
        { waitFor: 'Select a workstation', input: '\r' },
        { waitFor: 'Workstation action', input: 'Configure a section' },
        { waitFor: 'Search: Configure a section', input: '\r' },
        { waitFor: 'Choose setup section', input: 'Managed tools' },
        { waitFor: 'Search: Managed tools', input: '\r' },
        { waitFor: 'Managed tools', input: 'Update tools now' },
        { waitFor: 'Search: Update tools now', input: '\r' },
        {
          waitFor:
            'Install latest stable tools now? Running services are not restarted.',
          input: '\r',
        },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(8);
    expect(observed.result).toMatchObject({
      command: 'setup',
      ok: true,
      data: { section: 'tools', tools: 'unchanged' },
    });
    expect(writtenPaths(sprite)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(sprite.listServices).not.toHaveBeenCalled();
    expect(client.deleteSprite).not.toHaveBeenCalled();
  }, 15_000);

  it('should keep inspection and pairing off for details, then inspects only when selected', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-show-inspect-'),
    );
    const { client, sprite, execute } = await installedSprite(directory.path);
    const details = await driveInk(
      async (interaction) =>
        chooseWorkstationAction(dependencies, {
          request: {
            command: 'show',
            machine: 'temporary',
            options: {
              inspect: true,
              withPairCode: true,
            },
          },
          provider: providerOf(client),
          interaction,
        }),
      [{ waitFor: 'Workstation action', input: '\r' }],
    );

    expect(details.matchedSteps, details.output).toBe(1);
    expect(details.result).toMatchObject({ command: 'show', ok: true });
    expect(details.result.data).not.toHaveProperty('inspection');
    expect(details.result.data).not.toHaveProperty('pairing');
    expect(sprite.listServices).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    const inspection = await driveInk(
      async (interaction) =>
        chooseWorkstationAction(dependencies, {
          request: { command: 'show', machine: 'temporary', options: {} },
          provider: providerOf(client),
          interaction,
        }),
      [
        { waitFor: 'Workstation action', input: 'Inspect workstation' },
        { waitFor: 'Search: Inspect workstation', input: '\r' },
      ],
    );

    expect(inspection.matchedSteps, inspection.output).toBe(2);
    expect(inspection.result).toMatchObject({
      command: 'show',
      ok: true,
      data: { inspection: { services: [] } },
    });
    expect(sprite.listServices).toHaveBeenCalledOnce();
    expect(client.deleteSprite).not.toHaveBeenCalled();
  }, 15_000);

  it('should copy the selected workstation URL without opening its guest', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-show-copy-'),
    );
    const { client, sprite, execute } = await installedSprite(directory.path);
    const copyUrl = vi.spyOn(dependencies.host.clipboard, 'copyUrl');
    copyUrl.mockResolvedValue(undefined);

    const observed = await driveInk(
      async (interaction) =>
        chooseWorkstationAction(dependencies, {
          request: { command: 'show', machine: 'temporary', options: {} },
          provider: providerOf(client),
          interaction,
        }),
      [
        { waitFor: 'Workstation action', input: 'Copy T3 Code URL' },
        { waitFor: 'Search: Copy T3 Code URL', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(2);
    expect(observed.result).toMatchObject({
      command: 'show',
      ok: true,
      data: { action: 'copy' },
    });
    expect(copyUrl).toHaveBeenCalledExactlyOnceWith(sprite.url);
    expect(execute).not.toHaveBeenCalled();
  }, 15_000);

  it('should report a missing provider URL without writing to the clipboard', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-show-copy-no-url-'),
    );
    const { client, sprite } = await installedSprite(directory.path);
    Object.assign(sprite, { url: undefined });
    const copyUrl = vi.spyOn(dependencies.host.clipboard, 'copyUrl');

    const observed = await driveInk(
      async (interaction) =>
        chooseWorkstationAction(dependencies, {
          request: { command: 'show', machine: 'temporary', options: {} },
          provider: providerOf(client),
          interaction,
        }),
      [
        { waitFor: 'Workstation action', input: 'Copy T3 Code URL' },
        { waitFor: 'Search: Copy T3 Code URL', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(2);
    expect(observed.result).toMatchObject({
      command: 'show',
      ok: false,
      error: { code: 'PROVIDER', machine: 'temporary' },
    });
    expect(copyUrl).not.toHaveBeenCalled();
  }, 15_000);

  it('should return from the action menu to workstation selection before a new action', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-show-back-'),
    );
    const { client } = await installedSprite(directory.path);
    const observed = await driveInk(
      async (interaction) =>
        chooseWorkstationAction(dependencies, {
          request: { command: 'show', options: {} },
          provider: providerOf(client),
          interaction,
        }),
      [
        { waitFor: 'Select a workstation', input: '\r' },
        { waitFor: 'Workstation action', input: '\x1b' },
        { waitFor: 'Select a workstation', input: '\r' },
        { waitFor: 'Workstation action', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(4);
    expect(observed.result).toMatchObject({ command: 'show', ok: true });
    expect(client.getSprite).toHaveBeenCalledTimes(3);
    expect(client.deleteSprite).not.toHaveBeenCalled();
  }, 15_000);

  it('should return from setup section selection to the same workstation action menu', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-show-setup-back-'),
    );
    const { client, sprite } = await installedSprite(directory.path);
    const observed = await driveInk(
      async (interaction) =>
        chooseWorkstationAction(dependencies, {
          request: { command: 'show', machine: 'temporary', options: {} },
          provider: providerOf(client),
          interaction,
        }),
      [
        { waitFor: 'Workstation action', input: 'Configure a section' },
        { waitFor: 'Search: Configure a section', input: '\r' },
        { waitFor: 'Choose setup section', input: '\x1b' },
        { waitFor: 'Workstation action', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(4);
    expect(observed.result).toMatchObject({ command: 'show', ok: true });
    expect(writtenPaths(sprite)).toEqual([]);
    expect(client.deleteSprite).not.toHaveBeenCalled();
  }, 15_000);

  it('should disclose one pairing URL, code and expiry after a real menu choice without leaking the SDK token', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-show-pairing-'),
    );
    const pairingCode = 'menu-pairing-code-' + 'abc123'.repeat(24);
    const { client, execute } = await managedSprite(
      directory.path,
      pairingCode,
    );
    const observed = await driveInk(
      async (interaction) =>
        chooseWorkstationAction(dependencies, {
          request: {
            command: 'show',
            machine: 'primary',
            options: {},
          },
          provider: providerOf(client),
          interaction,
        }),
      [
        { waitFor: 'Workstation action', input: 'Pair another' },
        { waitFor: 'Search: Pair another', input: '\r' },
      ],
    );
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let human = '';
    let diagnostic = '';
    stdout.on('data', (chunk: Buffer) => {
      human += chunk.toString();
    });
    stderr.on('data', (chunk: Buffer) => {
      diagnostic += chunk.toString();
    });
    try {
      writePreparedResult(
        prepareResult({
          result: observed.result,
          options: {},
          streams: { stdout, stderr },
        }),
        { stdout, stderr },
      );
    } finally {
      stdout.destroy();
      stderr.destroy();
    }

    expect(observed.matchedSteps, observed.output).toBe(2);
    expect(observed.result).toMatchObject({
      ok: true,
      data: {
        pairing: { expiresAt: '2099-01-01T00:00:00Z' },
      },
    });
    expect(human).toContain(`Pairing code: ${pairingCode}`);
    expect(human).toContain(
      `https://primary.sprites.app/#token=${pairingCode}`,
    );
    expect(human).toContain('2099-01-01T00:00:00Z');
    expect(human.match(/https:\/\/primary\.sprites\.app/gu)).toHaveLength(1);
    expect(human).not.toContain('Pairing URL:');
    expect(human).not.toContain('test-org/1/0abc/0def');
    expect(diagnostic).toBe('');
    expect(observed.output).not.toContain('test-org/1/0abc/0def');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('should create pairing only when explicitly requested', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-show-pairing-'),
    );
    const pairingCode = 'direct-pairing-code-' + 'abc123'.repeat(24);
    const { client, execute } = await managedSprite(
      directory.path,
      pairingCode,
    );

    const result = await showWorkstation(dependencies, {
      request: {
        command: 'show',
        machine: 'primary',
        options: { withPairCode: true },
      },
      provider: providerOf(client),
    });

    expect(serializeResult(projectResult(result))).toMatchObject({
      ok: true,
      data: {
        machine: {
          agentUrl: `https://primary.sprites.app/#token=${pairingCode}`,
        },
        pairing: { token: pairingCode, expiresAt: '2099-01-01T00:00:00Z' },
      },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('should show the ordinary URL without opening the guest or minting pairing', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-show-pairing-'),
    );
    const { client, execute } = await managedSprite(
      directory.path,
      'unused-pairing-code',
    );

    const result = await showWorkstation(dependencies, {
      request: {
        command: 'show',
        machine: 'primary',
        options: {},
      },
      provider: providerOf(client),
    });

    expect(result).toMatchObject({
      ok: true,
      data: { machine: { agentUrl: 'https://primary.sprites.app' } },
    });
    expect(result.data).not.toHaveProperty('pairing');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('provider choice on an existing workstation', () => {
  it.each(['show', 'doctor', 'terminate'] as const)(
    'should answer %s from the provider --provider names without searching the others',
    async (command) => {
      vi.stubEnv('SPRITES_TOKEN', 'test-org/1/0abc/0def');
      vi.stubEnv('FLY_API_TOKEN', undefined);
      const getSprite = vi.spyOn(SpritesClient.prototype, 'getSprite');
      const listAllSprites = vi.spyOn(
        SpritesClient.prototype,
        'listAllSprites',
      );

      const result = await runCommand(dependencies, {
        command,
        machine: 'primary',
        options: {
          provider: 'fly-machine',
          json: true,
          nonInteractive: true,
          localCredentials: false,
          yes: true,
        },
      });

      expect(result).toMatchObject({
        command,
        ok: false,
        error: {
          code: 'INPUT',
          message: 'Provider prerequisites are missing or misconfigured',
          details: expect.arrayContaining([
            expect.stringContaining('FLY_API_TOKEN'),
          ]),
        },
      });
      expect(getSprite).not.toHaveBeenCalled();
      expect(listAllSprites).not.toHaveBeenCalled();
    },
  );

  it('should answer with sprite when only a provider token source is given', async () => {
    vi.stubEnv('OPEN_AGENT_TEST_SOURCE', 'FlyV1 fm2_generated-macaroon');
    vi.stubEnv('SPRITES_TOKEN', undefined);
    vi.stubEnv('FLY_API_TOKEN', undefined);

    const result = await runCommand(dependencies, {
      command: 'show',
      machine: 'primary',
      options: {
        providerTokenSource: 'env:OPEN_AGENT_TEST_SOURCE',
        json: true,
        nonInteractive: true,
        localCredentials: false,
      },
    });

    expect(result).toMatchObject({
      command: 'show',
      ok: false,
      error: {
        code: 'INPUT',
        details: [expect.stringContaining('holds a Fly API token')],
      },
    });
  });
});
