import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { writeResult } from '#cli/output';
import { serializeResult } from '#cli/serialization';
import { resultExitCode } from '#errors';
import { doctorWorkstation, showWorkstation } from '#inspect';
import { MANAGED_LABEL, SCHEMA_LABEL } from '#integrations/sprites';
import { OperationContext } from '#operation';
import { rememberSecret } from '#utilities/redaction';
import { runCommand } from '#workstation';
import { chooseWorkstationAction } from '#workstation/actions';

import { driveInk } from '../fixtures/ink.js';
import { createFilesystemSprite } from '../mocks/sprites.js';

/**
 * creates a managed SDK boundary with one installed disposable workstation
 * @param root isolated guest filesystem root
 * @returns provider client and managed Sprite
 */
async function installedSprite(root: string): Promise<{
  client: SpritesClient;
  sprite: Sprite;
  fixtureWriteCalls: number;
}> {
  const client = new SpritesClient('sdk-only-test-token');
  const sprite = Object.assign(
    createFilesystemSprite({
      root,
      execute: async () => ({ stdout: '[]', stderr: '', exitCode: 0 }),
    }),
    {
      id: 'sprite-temporary',
      organizationName: 'test-org',
      labels: [MANAGED_LABEL, SCHEMA_LABEL],
      url: 'https://temporary.sprites.app',
      status: 'running',
      listServices: vi.fn<Sprite['listServices']>(async () => []),
    },
  );
  vi.spyOn(client, 'listAllSprites').mockResolvedValue([sprite]);
  vi.spyOn(client, 'getSprite').mockResolvedValue(sprite);
  vi.spyOn(client, 'deleteSprite').mockResolvedValue(undefined);
  await sprite.filesystem().mkdir('/opt/agent-sprite', { recursive: true });
  await sprite.filesystem().writeJSON('/opt/agent-sprite/manifest.json', {
    schema: 1,
    createdAt: '2026-10-01T12:00:00Z',
    installedVersions: { node: '24.9.0' },
    integrations: { tailscale: false, exitNode: false, cliproxyapi: false },
  });
  const fixtureWriteCalls = vi.mocked(sprite.filesystem().writeFile).mock.calls
    .length;

  return { client, sprite, fixtureWriteCalls };
}

function managedSprite(pairingCode: string): {
  client: SpritesClient;
  sprite: Sprite;
} {
  const client = new SpritesClient('sdk-only-test-token');
  const sprite = Object.assign(new Sprite('primary', client), {
    id: 'sprite-primary',
    organizationName: 'test-org',
    labels: [MANAGED_LABEL, SCHEMA_LABEL],
    url: 'https://primary.sprites.app',
    status: 'running',
    execFile: vi.fn<Sprite['execFile']>(async () => ({
      stdout: `Token: ${pairingCode}\nExpires: 2099-01-01T00:00:00Z\n`,
      stderr: '',
      exitCode: 0,
    })),
  });
  vi.spyOn(client, 'getSprite').mockResolvedValue(sprite);

  return { client, sprite };
}

describe('cmd:show', () => {
  it('should serialize a non-Error SDK rejection as one redacted JSON failure', async () => {
    const privateRejection = 'sdk-private-rejection';
    rememberSecret(privateRejection);
    vi.stubEnv('SPRITES_TOKEN', 'sdk-only-test-token');
    vi.spyOn(SpritesClient.prototype, 'getSprite').mockRejectedValueOnce(
      privateRejection,
    );
    const result = await runCommand({
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
      writeResult(result, { json: true }, { stdout, stderr });
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
        join(tmpdir(), 'agent-sprite-action-failure-'),
      );
      const { client, sprite } = await installedSprite(directory.path);
      vi.mocked(client.getSprite)
        .mockResolvedValueOnce(sprite)
        .mockRejectedValueOnce(new Error('provider lookup unavailable'));

      const observed = await driveInk(
        async (interaction) =>
          chooseWorkstationAction(
            { command: 'show', machine: 'temporary', options: {} },
            client,
            interaction,
          ),
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

  it('should return a ready doctor result only from current service and provider discovery evidence', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-doctor-ready-'),
    );
    const { client, sprite } = await installedSprite(directory.path);
    await sprite
      .filesystem()
      .writeFile('/opt/agent-sprite/t3-provider-probe.js', 'probe installed');
    vi.mocked(sprite.listServices).mockResolvedValue([
      {
        name: 't3-code',
        cmd: '/opt/agent-sprite/t3-launcher',
        args: [],
        needs: [],
        state: { name: 't3-code', status: 'running' },
      },
      {
        name: 'agent-sprite-cron',
        cmd: '/opt/agent-sprite/update-schedule',
        args: [],
        needs: [],
        state: { name: 'agent-sprite-cron', status: 'running' },
      },
    ]);
    const discovery = {
      ok: true,
      scope: 't3-provider-discovery',
      workspace: '/home/agent',
      providers: ['claudeAgent', 'codex'].map((driver) => ({
        driver,
        instanceId: `${driver}-1`,
        enabled: true,
        installed: true,
        status: 'ready',
        checkedAt: '2026-10-09T00:00:00Z',
        commands: [],
        skills: [],
      })),
      limits: {
        ordinaryThreadStartup: 'unverified',
        runtimeHooks: 'unverified',
        mcp: 'unverified',
      },
    };
    vi.mocked(sprite.execFile).mockImplementation(async (_file, args) => ({
      stdout: args?.includes('/opt/agent-sprite/t3-provider-probe.js')
        ? JSON.stringify(discovery)
        : '[]',
      stderr: '',
      exitCode: 0,
    }));

    const result = await doctorWorkstation(client, 'temporary');

    expect(result).toMatchObject({
      command: 'doctor',
      ok: true,
      data: {
        currentReadiness: {
          ready: true,
          failures: [],
          services: expect.arrayContaining([
            { name: 't3-code', state: 'running' },
            { name: 'agent-sprite-cron', state: 'running' },
          ]),
          native: {
            t3ClaudePluginLoading: 'verified',
            t3CodexPluginLoading: 'verified',
          },
        },
      },
    });
    expect(serializeResult(result)).toMatchObject({
      schemaVersion: 1,
      command: 'doctor',
      ok: true,
      data: { currentReadiness: { ready: true } },
    });
  });

  it('should return typed failed doctor readiness from a real guest inspection', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-doctor-'),
    );
    const { client } = await installedSprite(directory.path);

    const result = await doctorWorkstation(client, 'temporary');

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
            'Tailscale connectivity',
            'CLIProxyAPI gateway',
          ]),
        },
      },
    });
    expect(serializeResult(result)).toMatchObject({
      schemaVersion: 1,
      command: 'doctor',
      ok: false,
      data: { currentReadiness: { ready: false } },
    });
  });

  it('should report a failed service probe with sibling evidence in doctor and both output modes', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-doctor-probe-failure-'),
    );
    const { client, sprite } = await installedSprite(directory.path);
    const secret = 'cor02-service-private-token';
    rememberSecret(secret);
    vi.mocked(sprite.listServices).mockRejectedValue(
      new Error(`service list failed ${secret}`),
    );

    const result = await doctorWorkstation(client, 'temporary');
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
              reason: expect.stringContaining('[REDACTED]'),
            },
          ],
          tailscale: { skipped: true },
          native: expect.any(Object),
        },
      },
    });

    for (const json of [false, true]) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let out = '';
      let err = '';
      stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString();
      });
      writeResult(result, { json }, { stdout, stderr });
      stdout.destroy();
      stderr.destroy();
      expect(out + err).toContain('services');
      expect(out + err).not.toContain(secret);
      if (json) {
        expect(err).toBe('');
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
        expect(err).toContain('service list failed');
      }
    }
  });

  it('should keep failed native inspection visible in show --inspect', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-show-probe-failure-'),
    );
    const { client, sprite } = await installedSprite(directory.path);
    vi.mocked(sprite.execFile).mockImplementation(async (_file, args) => {
      if (args?.includes('plugin') && args.includes('list')) {
        throw new Error('native SDK probe unavailable');
      }

      return { stdout: '[]', stderr: '', exitCode: 0 };
    });

    const result = await showWorkstation(
      { command: 'show', machine: 'temporary', options: { inspect: true } },
      client,
    );
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
    expect(serializeResult(result)).toMatchObject({
      data: { inspection: { probeFailures: [{ probe: 'native' }] } },
    });
  });

  it('should return cancellation exit 130 during a deferred doctor probe', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-doctor-cancel-'),
    );
    const { sprite } = await installedSprite(directory.path);
    const pending =
      Promise.withResolvers<Awaited<ReturnType<Sprite['listServices']>>>();
    vi.mocked(sprite.listServices).mockReturnValue(pending.promise);
    vi.spyOn(SpritesClient.prototype, 'getSprite').mockResolvedValue(sprite);
    vi.stubEnv('SPRITES_TOKEN', 'sdk-only-test-token');
    const controller = new AbortController();
    const context = new OperationContext({ signal: controller.signal });
    try {
      const resultPromise = runCommand(
        {
          command: 'doctor',
          machine: 'temporary',
          options: { nonInteractive: true, localCredentials: false },
        },
        undefined,
        context,
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
      join(tmpdir(), 'agent-sprite-show-terminate-'),
    );
    const { client, sprite } = await installedSprite(directory.path);

    const observed = await driveInk(
      async (interaction) =>
        chooseWorkstationAction(
          { command: 'show', options: { yes: true } },
          client,
          interaction,
        ),
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
    expect(sprite.execFile).not.toHaveBeenCalled();
  }, 15_000);

  it('should not carry show consent into setup tools, and still navigates real sections', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-show-setup-'),
    );
    const { client, sprite, fixtureWriteCalls } = await installedSprite(
      directory.path,
    );
    const observed = await driveInk(
      async (interaction) =>
        chooseWorkstationAction(
          {
            command: 'show',
            options: {
              yes: true,
              withT3PairCode: true,
              inspect: true,
              localCredentials: false,
              github: false,
            },
          },
          client,
          interaction,
        ),
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
            'Install latest stable tools and restart managed T3/Tailscale services now?',
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
    expect(sprite.filesystem().writeFile).toHaveBeenCalledTimes(
      fixtureWriteCalls,
    );
    expect(sprite.execFile).not.toHaveBeenCalled();
    expect(sprite.listServices).not.toHaveBeenCalled();
    expect(client.deleteSprite).not.toHaveBeenCalled();
  }, 15_000);

  it('should keep inspection and pairing off for details, then inspects only when selected', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-show-inspect-'),
    );
    const { client, sprite } = await installedSprite(directory.path);
    const details = await driveInk(
      async (interaction) =>
        chooseWorkstationAction(
          {
            command: 'show',
            machine: 'temporary',
            options: {
              inspect: true,
              withT3PairCode: true,
            },
          },
          client,
          interaction,
        ),
      [{ waitFor: 'Workstation action', input: '\r' }],
    );

    expect(details.matchedSteps, details.output).toBe(1);
    expect(details.result).toMatchObject({ command: 'show', ok: true });
    expect(details.result.data).not.toHaveProperty('inspection');
    expect(details.result.data).not.toHaveProperty('pairing');
    expect(sprite.listServices).not.toHaveBeenCalled();
    expect(sprite.execFile).not.toHaveBeenCalled();

    const inspection = await driveInk(
      async (interaction) =>
        chooseWorkstationAction(
          { command: 'show', machine: 'temporary', options: {} },
          client,
          interaction,
        ),
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

  it('should return from the action menu to workstation selection before a new action', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'agent-sprite-show-back-'),
    );
    const { client } = await installedSprite(directory.path);
    const observed = await driveInk(
      async (interaction) =>
        chooseWorkstationAction(
          { command: 'show', options: {} },
          client,
          interaction,
        ),
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
  it('should disclose one pairing URL, code and expiry after a real menu choice without leaking the SDK token', async () => {
    const pairingCode = 'menu-pairing-code-' + 'abc123'.repeat(24);
    const { client, sprite } = managedSprite(pairingCode);
    const observed = await driveInk(
      async (interaction) =>
        chooseWorkstationAction(
          {
            command: 'show',
            machine: 'primary',
            options: {},
          },
          client,
          interaction,
        ),
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
      writeResult(observed.result, {}, { stdout, stderr });
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
    expect(human).not.toContain('sdk-only-test-token');
    expect(diagnostic).toBe('');
    expect(observed.output).not.toContain('sdk-only-test-token');
    expect(sprite.execFile).toHaveBeenCalledOnce();
  });

  it('should create pairing only when explicitly requested', async () => {
    const pairingCode = 'direct-pairing-code-' + 'abc123'.repeat(24);
    const { client, sprite } = managedSprite(pairingCode);

    const result = await showWorkstation(
      {
        command: 'show',
        machine: 'primary',
        options: { withT3PairCode: true },
      },
      client,
    );

    expect(serializeResult(result)).toMatchObject({
      ok: true,
      data: {
        machine: { t3Url: `https://primary.sprites.app/#token=${pairingCode}` },
        pairing: { token: pairingCode, expiresAt: '2099-01-01T00:00:00Z' },
      },
    });
    expect(sprite.execFile).toHaveBeenCalledOnce();
  });

  it('should show the ordinary URL without opening the guest or minting pairing', async () => {
    const { client, sprite } = managedSprite('unused-pairing-code');

    const result = await showWorkstation(
      {
        command: 'show',
        machine: 'primary',
        options: {},
      },
      client,
    );

    expect(result).toMatchObject({
      ok: true,
      data: { machine: { t3Url: 'https://primary.sprites.app' } },
    });
    expect(result.data).not.toHaveProperty('pairing');
    expect(sprite.execFile).not.toHaveBeenCalled();
  });
});
