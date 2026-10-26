import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import {
  MANAGED_LABEL,
  mergeMetadataLabels,
  SCHEMA_LABEL,
} from '#adapters/drivers/providers/sprite/labels';
import { ENVIRONMENT_PATH } from '#adapters/guest/platform/layout';
import { runCommand } from '#application/workstation';
import { summarizeProfile } from '#domain/recorded';
import { OperationContext } from '#kernel/operation';
import { OPEN_AGENT_VERSION } from '#kernel/version';

import { environmentOf } from '../fixtures/environment';
import { DISABLED_NETWORK_PROFILE } from '../fixtures/profile';
import { dependencies, dependenciesWith } from '../mocks/dependencies';
import { createFilesystemSprite, holdServices } from '../mocks/sprites';

import type { Sprite } from '@fly/sprites';

import type { GuestMechanics } from '#application/ports/guest';
import type { Interaction } from '#application/ports/interaction';
import type { GuestInspection } from '#domain/observations/inspection';

// a selected setup section runs through the framed guest shell boundary
vi.mock(
  '#adapters/guest/platform/session/open',
  async () => import('../mocks/session'),
);

const TOKEN = 'workflow-org/1234/0123abcd/4567ef89';
const options = { nonInteractive: true, localCredentials: false } as const;

function withoutProviderCredentials(): void {
  vi.stubEnv('SPRITES_TOKEN', undefined);
  vi.stubEnv('FLY_API_TOKEN', undefined);
}

function spriteCredential(): void {
  vi.stubEnv('SPRITES_TOKEN', TOKEN);
  vi.stubEnv('FLY_API_TOKEN', undefined);
}

async function managedSprite(root: string): Promise<Sprite> {
  const sprite = Object.assign(
    createFilesystemSprite({
      root,
      name: 'workstation',
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    }),
    {
      id: 'sprite-workstation',
      organizationName: 'fixture-organization',
      labels: mergeMetadataLabels([MANAGED_LABEL, SCHEMA_LABEL], {
        setup: 'ready',
        profile: summarizeProfile(DISABLED_NETWORK_PROFILE),
        version: OPEN_AGENT_VERSION,
      }),
      url: 'https://workstation.sprites.app/',
      status: 'running',
    },
  );
  vi.spyOn(SpritesClient.prototype, 'getSprite').mockResolvedValue(sprite);
  vi.spyOn(sprite, 'update').mockImplementation(async (update) =>
    Object.assign(sprite, update),
  );
  vi.spyOn(sprite, 'updateURLSettings').mockResolvedValue(undefined);
  const agentName =
    dependencies.registry.agents[DISABLED_NETWORK_PROFILE.agent].service.name;
  holdServices(sprite).set(agentName, {
    name: agentName,
    cmd: '/bin/true',
    args: [],
    needs: [],
    state: { name: agentName, status: 'running' },
  });
  await sprite
    .filesystem()
    .writeFile(
      ENVIRONMENT_PATH,
      JSON.stringify(environmentOf(DISABLED_NETWORK_PROFILE)),
    );

  return sprite;
}

const interaction: Interaction = {
  input: async () => '',
  secret: async () => '',
  select: async (_prompt, choices) => choices[0]!.value,
  multiselect: async () => [],
  confirm: async () => true,
  progress: () => undefined,
  status: () => undefined,
};

describe('fn:runCommand', () => {
  it('should dispatch create and report missing provider credentials before creating a machine', async () => {
    withoutProviderCredentials();
    const create = vi.spyOn(SpritesClient.prototype, 'createSprite');
    const stages: string[] = [];
    const operation = new OperationContext({
      signal: new AbortController().signal,
      onStage: ({ stage, event }) => stages.push(`${stage}:${event}`),
    });

    const result = await runCommand(
      dependencies,
      {
        command: 'create',
        options: {
          ...options,
          provider: 'sprite',
          name: 'workstation',
          yes: true,
          github: false,
          plugins: false,
          gitIdentity: false,
          network: 'none',
          proxy: false,
        },
      },
      { operation },
    );

    expect(result).toMatchObject({
      command: 'create',
      ok: false,
      error: { code: 'INPUT' },
    });
    expect(stages).toContain('create.preflight:start');
    expect(create).not.toHaveBeenCalled();
  });

  it('should list available providers and mark providers without credentials unavailable', async () => {
    spriteCredential();
    const list = vi
      .spyOn(SpritesClient.prototype, 'listAllSprites')
      .mockResolvedValue([]);

    const result = await runCommand(dependencies, {
      command: 'list',
      options,
    });

    expect(result).toMatchObject({
      command: 'list',
      ok: true,
      data: {
        machines: [],
        unavailable: [{ provider: 'fly-machine', code: 'INPUT' }],
      },
    });
    expect(list).toHaveBeenCalledOnce();
  });

  it('should apply an explicit list credential source to the default provider', async () => {
    withoutProviderCredentials();
    vi.stubEnv('OPEN_AGENT_SPRITE_SOURCE', TOKEN);
    const list = vi
      .spyOn(SpritesClient.prototype, 'listAllSprites')
      .mockResolvedValue([]);

    const result = await runCommand(dependencies, {
      command: 'list',
      options: {
        ...options,
        providerTokenSource: 'env:OPEN_AGENT_SPRITE_SOURCE',
      },
    });

    expect(result).toMatchObject({
      command: 'list',
      ok: true,
      data: {
        machines: [],
        unavailable: [{ provider: 'fly-machine', code: 'INPUT' }],
      },
    });
    expect(list).toHaveBeenCalledOnce();
  });

  it('should explain unavailable prompts in a caller-owned operation when no provider can list', async () => {
    withoutProviderCredentials();
    const operation = new OperationContext({
      signal: new AbortController().signal,
    });
    operation.setPromptBlocker('this invocation has no terminal');

    const result = await runCommand(
      dependencies,
      { command: 'list', options },
      { operation },
    );

    expect(result).toMatchObject({
      command: 'list',
      ok: false,
      error: {
        code: 'INPUT',
        details: expect.arrayContaining([
          expect.stringContaining('this invocation has no terminal'),
        ]),
      },
    });
    expect(operation.closed).toBe(true);
  });

  it('should report missing prerequisites without prompt guidance for a direct command', async () => {
    withoutProviderCredentials();

    const result = await runCommand(dependencies, {
      command: 'show',
      machine: 'workstation',
      options: { ...options, provider: 'sprite' },
    });

    expect(result).toMatchObject({
      command: 'show',
      ok: false,
      error: { code: 'INPUT', details: expect.any(Array) },
    });
    if (!result.ok) {
      expect(result.error.details).not.toContainEqual(
        expect.stringContaining('Prompts are disabled'),
      );
    }
  });

  it('should reject an entered credential that fails provider preflight', async () => {
    withoutProviderCredentials();
    const secret = vi.fn(async () => 'FlyV1 fm2_generated-macaroon');
    const wired = dependenciesWith({
      defaults: {
        ...dependencies.defaults,
        selection: {
          ...dependencies.defaults.selection,
          provider: 'fly-machine',
        },
      },
      host: {
        ...dependencies.host,
        tools: {
          ...dependencies.host.tools,
          findTool: async () => undefined,
        },
      },
    });

    const result = await runCommand(
      wired,
      { command: 'list', options: { localCredentials: false } },
      { interaction: { ...interaction, secret } },
    );

    expect(result).toMatchObject({
      command: 'list',
      ok: false,
      error: { code: 'INPUT', details: expect.any(Array) },
    });
    expect(secret).toHaveBeenCalledOnce();
  });

  it('should list with a credential entered through the interaction', async () => {
    withoutProviderCredentials();
    const secret = vi.fn(async () => TOKEN);
    const list = vi
      .spyOn(SpritesClient.prototype, 'listAllSprites')
      .mockResolvedValue([]);

    const result = await runCommand(
      dependencies,
      { command: 'list', options: { localCredentials: false } },
      { interaction: { ...interaction, secret } },
    );

    expect(result).toMatchObject({
      command: 'list',
      ok: true,
      data: { machines: [], unavailable: [] },
    });
    expect(secret).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledOnce();
  });

  it('should report current readiness from the selected workstation', async () => {
    spriteCredential();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-command-doctor-'),
    );
    await managedSprite(directory.path);
    const observation = {
      services: [],
      network: { online: false, skipped: true },
      hub: { reachable: false, skipped: true },
      environment: environmentOf(DISABLED_NETWORK_PROFILE),
      probeFailures: [],
      governor: { recorded: false, reason: 'no awake event has been recorded' },
    } satisfies GuestInspection;
    const inspect = vi.fn<GuestMechanics['inspection']['inspect']>(
      async () => observation,
    );
    const wired = dependenciesWith({
      guest: {
        ...dependencies.guest,
        inspection: { ...dependencies.guest.inspection, inspect },
      },
    });

    const result = await runCommand(wired, {
      command: 'doctor',
      machine: 'workstation',
      options: { ...options, provider: 'sprite' },
    });

    expect(result).toMatchObject({
      command: 'doctor',
      ok: false,
      error: { code: 'PREFLIGHT', machineId: 'sprite-workstation' },
      data: {
        machine: { id: 'sprite-workstation', name: 'workstation' },
        currentReadiness: {
          ready: false,
          services: [],
          environment: observation.environment,
        },
      },
    });
    expect(inspect).toHaveBeenCalledOnce();
  });

  it('should apply the selected network setup section to a managed workstation', async () => {
    spriteCredential();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-command-setup-'),
    );
    await managedSprite(directory.path);

    const result = await runCommand(dependencies, {
      command: 'setup',
      machine: 'workstation',
      options: {
        ...options,
        provider: 'sprite',
        section: 'network',
        network: 'none',
        github: false,
        gitIdentity: false,
        plugins: false,
      },
    });

    expect(result).toMatchObject({
      command: 'setup',
      ok: true,
      data: {
        section: 'network',
        network: { status: 'disabled', readiness: 'skipped' },
      },
    });
  });

  it('should cancel termination when the typed workstation name differs', async () => {
    spriteCredential();
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-command-terminate-'),
    );
    await managedSprite(directory.path);
    const input = vi.fn(async () => 'another-workstation');
    const deletion = vi.spyOn(SpritesClient.prototype, 'deleteSprite');

    const result = await runCommand(
      dependencies,
      {
        command: 'terminate',
        machine: 'workstation',
        options: { provider: 'sprite', localCredentials: false, yes: false },
      },
      { interaction: { ...interaction, input } },
    );

    expect(result).toMatchObject({
      command: 'terminate',
      ok: false,
      error: { code: 'CANCELLED' },
    });
    expect(input).toHaveBeenCalledWith(
      expect.objectContaining({ required: true }),
    );
    expect(deletion).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'should offer pairing only for an agent that supports it (%s)',
    async (supportsPairing) => {
      spriteCredential();
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-command-actions-'),
      );
      await managedSprite(directory.path);
      const selections: string[] = [];
      const actions: string[][] = [];
      const wired = {
        ...dependencies,
        registry: {
          ...dependencies.registry,
          agents: {
            ...dependencies.registry.agents,
            t3: { ...dependencies.registry.agents.t3, supportsPairing },
          },
        },
      };

      const result = await runCommand(
        wired,
        {
          command: 'show',
          machine: 'workstation',
          options: { provider: 'sprite', localCredentials: false },
        },
        {
          interaction: {
            ...interaction,
            select: async (_prompt, choices) => {
              selections.push(_prompt.message);
              actions.push(choices.map((choice) => choice.value));

              return choices[0]!.value;
            },
          },
        },
      );

      expect(result).toMatchObject({
        command: 'show',
        ok: true,
        data: { machine: { id: 'sprite-workstation', name: 'workstation' } },
      });
      expect({ selections, actions }).toEqual({
        selections: ['Workstation action'],
        actions: [
          [
            'details',
            ...(supportsPairing ? ['pair'] : []),
            'inspect',
            'setup',
            'copy',
            'terminate',
          ],
        ],
      });
    },
  );

  it('should retain known identity and recovery guidance when its caller cancels', async () => {
    const controller = new AbortController();
    const operation = new OperationContext({ signal: controller.signal });
    operation.identify({ id: 'sprite-workstation', name: 'workstation' });
    controller.abort();

    const result = await runCommand(
      dependencies,
      { command: 'show', machine: 'requested-name', options },
      { operation },
    );

    expect(result).toMatchObject({
      command: 'show',
      ok: false,
      error: {
        code: 'CANCELLED',
        machine: 'workstation',
        machineId: 'sprite-workstation',
        details: expect.arrayContaining([
          expect.stringContaining('workstation'),
        ]),
      },
    });
    expect(operation.closed).toBe(true);
  });
});
