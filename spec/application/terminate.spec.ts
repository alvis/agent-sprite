import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import {
  TAILSCALE_STATE_FILE,
  tailscaleCommand,
} from '#adapters/drivers/networks/tailscale/service';
import {
  MANAGED_LABEL,
  SCHEMA_LABEL,
} from '#adapters/drivers/providers/sprite/labels';
import { terminateWorkstation } from '#application/terminate';
import { registry } from '#composition/registry';

import { InteractionExit } from '#kernel/navigation';
import { OperationContext, withOperation } from '#kernel/operation';

import { environmentOf } from '../fixtures/environment';
import {
  DISABLED_NETWORK_PROFILE,
  TAILSCALE_PROFILE,
} from '../fixtures/profile';
import { dependencies, dependenciesWith } from '../mocks/dependencies';
import { createFilesystemSprite, providerOf } from '../mocks/sprites';

import type { Sprite } from '@fly/sprites';
import type { Mock } from 'vitest';

import type { CommandRequest } from '#application/contracts';
import type { Interaction } from '#application/ports/interaction';
import type { StageEvent } from '#kernel/operation';

import type { GuestExecute } from '../mocks/sprites';

const environment = environmentOf(TAILSCALE_PROFILE);

/**
 * creates a verified provider target with actual isolated guest files
 * @param root disposable directory for guest and local inputs
 * @returns exact-target request, SDK-only provider boundary and the guest's
 * answer to every command other than a file program
 */
async function createTerminationBoundary(root: string): Promise<{
  sprite: Sprite;
  execute: Mock<GuestExecute>;
  client: SpritesClient;
  request: CommandRequest;
}> {
  const execute = vi.fn<GuestExecute>(async () => ({
    stdout: '',
    stderr: 'native status unavailable',
    exitCode: 1,
  }));
  const sprite = Object.assign(createFilesystemSprite({ root, execute }), {
    id: 'sprite-incomplete',
    organizationName: 'test-organization',
    labels: [MANAGED_LABEL, SCHEMA_LABEL],
  });
  const client = Object.assign(new SpritesClient('test-token'), {
    getSprite: vi.fn<SpritesClient['getSprite']>(async () => sprite),
    deleteSprite: vi.fn<SpritesClient['deleteSprite']>(async () => undefined),
  } satisfies Partial<SpritesClient>);
  const envPath = join(root, 'selected.env');
  await writeFile(
    envPath,
    ['OPEN_AGENT_NETWORK=none', 'CLIPROXYAPI_ENABLED=false', ''].join('\n'),
  );
  vi.stubEnv('TAILSCALE_API_KEY', '');
  const request = {
    command: 'terminate',
    machine: sprite.name,
    options: {
      credentialFile: envPath,
      yes: true,
      nonInteractive: true,
      localCredentials: false,
      github: false,
    },
  } satisfies CommandRequest;

  return { sprite, execute, client, request };
}

/**
 * a deletion prompt whose typed answer is controlled by the test
 * @param typedName answer supplied to the deletion prompt
 * @returns interaction recording status and progress
 */
function deletionInteraction(typedName: string): Interaction {
  const refuse = async (): Promise<never> => {
    throw new Error('unexpected termination prompt');
  };

  return {
    input: vi.fn(async () => typedName),
    secret: refuse,
    select: refuse,
    multiselect: refuse,
    confirm: refuse,
    progress: vi.fn(),
    status: vi.fn(),
  };
}

describe('fn:terminateWorkstation', () => {
  it('should reject a Fly machine with an empty API identity before deletion', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input))
        .pathname;
      const body: unknown =
        path === '/v1/tokens/current'
          ? { tokens: [{ org_slug: 'test-organization' }] }
          : path === '/v1/apps/temporary'
            ? {
                id: 'app-temporary',
                name: 'temporary',
                internal_numeric_id: 42,
                organization: { slug: 'test-organization' },
              }
            : path === '/v1/apps/temporary/machines'
              ? [
                  {
                    id: '',
                    state: 'started',
                    config: {
                      metadata: {
                        'open-agent': 'managed',
                        'open-agent-schema': '1',
                      },
                    },
                  },
                ]
              : undefined;
      if (body === undefined) {
        throw new Error(`Unexpected Fly API request: ${path}`);
      }

      return Response.json(body);
    });
    vi.stubGlobal('fetch', fetch);
    const provider = registry.providers['fly-machine'].authenticate({
      credential: 'FlyV1 fm2_test',
      restorableServices: [],
    });

    await expect(
      terminateWorkstation(
        dependenciesWith({
          guest: {
            ...dependencies.guest,
            release: {
              ...dependencies.guest.release,
              assertSupported: async () => undefined,
            },
          },
        }),
        {
          request: {
            command: 'terminate',
            machine: 'temporary',
            options: { yes: true, nonInteractive: true },
          },
          provider,
        },
      ),
    ).rejects.toMatchObject({
      code: 'PROVIDER',
      message: expect.stringMatching(/^Selected workstation /u),
    });
    expect(
      fetch.mock.calls.every(([, init]) => init?.method !== 'DELETE'),
    ).toBe(true);
  });

  it.each([
    { machine: undefined, yes: true },
    { machine: 'named-target', yes: false },
  ])(
    'should refuse unattended deletion without an exact name and consent',
    async ({ machine, yes }) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-terminate-unattended-'),
      );
      const { client, request } = await createTerminationBoundary(
        directory.path,
      );

      await expect(
        terminateWorkstation(dependencies, {
          request: {
            ...request,
            machine,
            options: { ...request.options, yes },
          },
          provider: providerOf(client),
        }),
      ).rejects.toEqual(expect.objectContaining({ code: 'USAGE' }));
      expect(client.getSprite).not.toHaveBeenCalled();
      expect(client.deleteSprite).not.toHaveBeenCalled();
    },
  );

  it('should cancel before guest inspection when the typed name differs', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-typed-mismatch-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    const interaction = deletionInteraction('another-workstation');

    const result = await terminateWorkstation(dependencies, {
      request: { ...request, options: { ...request.options, yes: false } },
      provider: providerOf(client),
      interaction,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(interaction.input).toHaveBeenCalledExactlyOnceWith({
      message: `Type ${sprite.name} to delete it`,
      required: true,
    });
    expect(interaction.status).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'warning' }),
    );
    expect(sprite.filesystem().exists).not.toHaveBeenCalled();
    expect(client.deleteSprite).not.toHaveBeenCalled();
  });

  it('should delete after the typed name matches and report progress', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-typed-match-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    const interaction = deletionInteraction(sprite.name);

    const result = await terminateWorkstation(dependencies, {
      request: { ...request, options: { ...request.options, yes: false } },
      provider: providerOf(client),
      interaction,
    });

    expect(result).toMatchObject({ ok: true });
    expect(interaction.progress).toHaveBeenCalledWith({
      stage: 'terminate',
      message: `Deleting workstation ${sprite.name}`,
    });
    expect(client.deleteSprite).toHaveBeenCalledExactlyOnceWith(sprite.name);
  });

  it.each([undefined, ''])(
    'should require a typed name after selecting a workstation with no requested name (%s)',
    async (machine) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-terminate-selected-'),
      );
      const { sprite, client, request } = await createTerminationBoundary(
        directory.path,
      );
      const listAllSprites = vi.fn<SpritesClient['listAllSprites']>(
        async () => [sprite],
      );
      Object.assign(client, { listAllSprites });
      const input = vi.fn(async () => sprite.name);
      const interaction: Interaction = {
        ...deletionInteraction(sprite.name),
        input,
        select: async (_prompt, choices) => {
          const selected = choices[0];
          if (!selected) {
            throw new Error('no workstation was offered');
          }

          return selected.value;
        },
      };

      const result = await terminateWorkstation(dependencies, {
        request: { ...request, machine },
        provider: providerOf(client),
        interaction,
      });

      expect(result).toMatchObject({ ok: true });
      expect(listAllSprites).toHaveBeenCalledOnce();
      expect(input).toHaveBeenCalledExactlyOnceWith({
        message: `Type ${sprite.name} to delete it`,
        required: true,
      });
      expect(client.deleteSprite).toHaveBeenCalledExactlyOnceWith(sprite.name);
    },
  );

  it('should refuse a supplied name that differs from the ownership-verified Sprite before deletion', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-mismatch-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );

    await expect(
      terminateWorkstation(dependencies, {
        request: { ...request, machine: 'different-target' },
        provider: providerOf(client),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'CONFLICT',
        message: expect.stringMatching(
          /does not match the verified workstation/,
        ),
      }),
    );

    expect(client.getSprite).toHaveBeenCalledExactlyOnceWith(
      'different-target',
    );
    expect(sprite.filesystem().exists).not.toHaveBeenCalled();
    expect(client.deleteSprite).not.toHaveBeenCalled();
  });

  it('should delete a verified incomplete workstation without requiring an absent environment or enrollment state', async () => {
    for (const hasManifest of [false, true]) {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-terminate-incomplete-'),
      );
      const { sprite, execute, client, request } =
        await createTerminationBoundary(directory.path);
      if (hasManifest) {
        await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
        await sprite
          .filesystem()
          .writeJSON('/opt/open-agent/environment.json', environment);
      }

      const result = await terminateWorkstation(dependencies, {
        request,
        provider: providerOf(client),
      });

      expect(result).toMatchObject({
        command: 'terminate',
        ok: true,
        data: {
          workstation: { status: 'deleted', id: sprite.id, name: sprite.name },
          network: { status: 'no device identity recorded' },
        },
      });
      expect(client.deleteSprite).toHaveBeenCalledExactlyOnceWith(sprite.name);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it('should skip network cleanup for a workstation that joined no private network', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-none-'),
    );
    const { sprite, execute, client, request } =
      await createTerminationBoundary(directory.path);
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
    await sprite.filesystem().writeJSON('/opt/open-agent/environment.json', {
      ...environment,
      profile: DISABLED_NETWORK_PROFILE,
    });

    const result = await terminateWorkstation(dependencies, {
      request,
      provider: providerOf(client),
    });

    expect(result).toMatchObject({
      command: 'terminate',
      ok: true,
      data: {
        workstation: { status: 'deleted', id: sprite.id, name: sprite.name },
        network: { status: 'no device identity recorded' },
      },
    });
    expect(client.deleteSprite).toHaveBeenCalledExactlyOnceWith(sprite.name);
    expect(execute).not.toHaveBeenCalled();
  });

  it('should preserve disabled recorded identity and report required cleanup after Sprite deletion without an API token', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-disabled-'),
    );
    const { sprite, execute, client, request } =
      await createTerminationBoundary(directory.path);
    const filesystem = sprite.filesystem();
    await filesystem.mkdir('/opt/open-agent', { recursive: true });
    await filesystem.mkdir(dirname(TAILSCALE_STATE_FILE), { recursive: true });
    await filesystem.writeFile(TAILSCALE_STATE_FILE, 'enrolled');
    await filesystem.writeJSON('/opt/open-agent/environment.json', {
      ...environment,
      profile: DISABLED_NETWORK_PROFILE,
      networkIdentity: {
        network: 'tailscale',
        deviceId: 'managed-node',
        ip: '100.100.100.1',
      },
    });

    const result = await terminateWorkstation(dependencies, {
      request,
      provider: providerOf(client),
    });

    expect(result).toMatchObject({
      command: 'terminate',
      ok: false,
      data: {
        workstation: { status: 'deleted', id: sprite.id, name: sprite.name },
        network: {
          status: 'cleanup required',
          deviceId: 'managed-node',
          address: '100.100.100.1',
        },
      },
      error: { code: 'INPUT' },
    });
    expect(client.deleteSprite).toHaveBeenCalledExactlyOnceWith(sprite.name);
    // the stopped daemon cannot report, so the recorded identity stands
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/sudo',
      ['-n', '-E', '--', ...tailscaleCommand('status', '--json')],
      expect.any(Object),
    );
  });

  it('should delete the recorded device with the management credential of the recorded network', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-network-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('TAILSCALE_API_KEY', 'generated-management-key');
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
    await sprite.filesystem().writeJSON('/opt/open-agent/environment.json', {
      ...environment,
      networkIdentity: {
        network: 'tailscale',
        deviceId: 'managed-node',
        ip: '100.100.100.1',
      },
    });

    const result = await terminateWorkstation(dependencies, {
      request,
      provider: providerOf(client),
    });

    expect(result).toMatchObject({
      command: 'terminate',
      ok: true,
      data: {
        workstation: { status: 'deleted', id: sprite.id, name: sprite.name },
        network: { status: 'deleted', deviceId: 'managed-node' },
      },
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      new URL('https://api.tailscale.com/api/v2/device/managed-node'),
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer generated-management-key',
        }),
      }),
    );
  });

  it('should report a failed network cleanup stage after deleting the workstation when the management API fails', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-cleanup-failure-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    vi.stubEnv('TAILSCALE_API_KEY', 'generated-management-key');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>(
        async () => new Response('server unavailable', { status: 503 }),
      ),
    );
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
    await sprite.filesystem().writeJSON('/opt/open-agent/environment.json', {
      ...environment,
      networkIdentity: {
        network: 'tailscale',
        deviceId: 'managed-node',
        ip: '100.100.100.1',
      },
    });
    const stages: StageEvent[] = [];
    const operation = new OperationContext({
      signal: new AbortController().signal,
      onStage: (event) => stages.push(event),
    });

    const result = await withOperation(operation, async () =>
      terminateWorkstation(dependencies, {
        request,
        provider: providerOf(client),
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      data: { workstation: { status: 'deleted' } },
      error: { machine: sprite.name },
    });
    expect(stages).toContainEqual(
      expect.objectContaining({
        stage: 'terminate.network',
        event: 'complete',
        outcome: 'failed',
      }),
    );
    expect(client.deleteSprite).toHaveBeenCalledExactlyOnceWith(sprite.name);
  });

  it('should refuse deletion when enrollment state exists but native inspection cannot capture an identity', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-identity-'),
    );
    const { sprite, execute, client, request } =
      await createTerminationBoundary(directory.path);
    await sprite
      .filesystem()
      .mkdir(dirname(TAILSCALE_STATE_FILE), { recursive: true });
    await sprite.filesystem().writeFile(TAILSCALE_STATE_FILE, 'enrolled');

    await expect(
      terminateWorkstation(dependencies, {
        request,
        provider: providerOf(client),
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'PREFLIGHT' }));

    expect(client.deleteSprite).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/sudo',
      ['-n', '-E', '--', ...tailscaleCommand('status', '--json')],
      expect.any(Object),
    );
  });

  it('should refuse deletion when a deselected network kept enrollment state but no identity was recorded', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-deselected-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    const filesystem = sprite.filesystem();
    await filesystem.mkdir('/opt/open-agent', { recursive: true });
    await filesystem.mkdir(dirname(TAILSCALE_STATE_FILE), { recursive: true });
    await filesystem.writeFile(TAILSCALE_STATE_FILE, 'enrolled');
    await filesystem.writeJSON('/opt/open-agent/environment.json', {
      ...environment,
      profile: DISABLED_NETWORK_PROFILE,
    });

    await expect(
      terminateWorkstation(dependencies, {
        request,
        provider: providerOf(client),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'PREFLIGHT',
        message: expect.stringMatching(
          /device identity could not be captured/u,
        ),
      }),
    );

    expect(client.deleteSprite).not.toHaveBeenCalled();
  });

  it('should name the network that recorded the identity as owner after the workstation switched to none', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-recorded-owner-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    const filesystem = sprite.filesystem();
    await filesystem.mkdir('/opt/open-agent', { recursive: true });
    await filesystem.writeJSON('/opt/open-agent/environment.json', {
      ...environment,
      profile: DISABLED_NETWORK_PROFILE,
      networkIdentity: {
        network: 'tailscale',
        deviceId: 'managed-node',
        ip: '100.100.100.1',
      },
    });

    const result = await terminateWorkstation(dependencies, {
      request,
      provider: providerOf(client),
    });

    expect(result).toMatchObject({
      ok: false,
      data: {
        network: { status: 'cleanup required', deviceId: 'managed-node' },
      },
      error: {
        message: expect.stringMatching(/Tailscale device managed-node/u),
      },
    });
  });

  it('should identify an outstanding cleanup by address when no device ID was recorded', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-address-only-'),
    );
    const { sprite, client, request } = await createTerminationBoundary(
      directory.path,
    );
    await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
    await sprite.filesystem().writeJSON('/opt/open-agent/environment.json', {
      ...environment,
      networkIdentity: {
        network: 'tailscale',
        ip: '100.100.100.9',
      },
    });

    const result = await terminateWorkstation(dependencies, {
      request,
      provider: providerOf(client),
    });

    expect(result).toMatchObject({
      ok: false,
      data: {
        workstation: { status: 'deleted' },
        network: { status: 'cleanup required', address: '100.100.100.9' },
      },
      error: {
        code: 'INPUT',
        message: expect.stringContaining('100.100.100.9'),
      },
    });
    expect(client.deleteSprite).toHaveBeenCalledExactlyOnceWith(sprite.name);
  });

  it.each([
    {
      networkIdentity: { network: 'tailscale' as const, ip: '100.100.100.9' },
      target: '100.100.100.9',
    },
    { networkIdentity: undefined, target: 'the recorded device' },
  ])(
    'should retain the $target cleanup target when cancelled after provider deletion',
    async ({ networkIdentity, target }) => {
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'open-agent-terminate-cleanup-cancelled-'),
      );
      const { sprite, client, request } = await createTerminationBoundary(
        directory.path,
      );
      await sprite.filesystem().mkdir('/opt/open-agent', { recursive: true });
      await sprite.filesystem().writeJSON('/opt/open-agent/environment.json', {
        ...environment,
        ...(networkIdentity ? { networkIdentity } : {}),
      });
      const controller = new AbortController();
      const operation = new OperationContext({
        signal: controller.signal,
        onStage: (event) => {
          if (event.stage === 'terminate.network' && event.event === 'start') {
            controller.abort();
          }
        },
      });

      const result = await withOperation(operation, async () =>
        terminateWorkstation(dependencies, {
          request,
          provider: providerOf(client),
        }),
      );

      expect(result).toMatchObject({
        ok: false,
        data: { workstation: { status: 'deleted' } },
        error: {
          code: 'CANCELLED',
          message: expect.stringContaining(target),
        },
      });
      expect(client.deleteSprite).toHaveBeenCalledExactlyOnceWith(sprite.name);
    },
  );

  it('should retain the caught status parser failure as a private provider cause before deletion', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-probe-'),
    );
    const { sprite, execute, client, request } =
      await createTerminationBoundary(directory.path);
    await sprite
      .filesystem()
      .mkdir(dirname(TAILSCALE_STATE_FILE), { recursive: true });
    await sprite.filesystem().writeFile(TAILSCALE_STATE_FILE, 'enrolled');
    execute.mockResolvedValueOnce({
      stdout: '{private-body',
      stderr: '',
      exitCode: 0,
    });

    await expect(
      terminateWorkstation(dependencies, {
        request,
        provider: providerOf(client),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'PROVIDER',
        cause: expect.any(SyntaxError),
        causeVisibility: 'private',
      }),
    );
    expect(client.deleteSprite).not.toHaveBeenCalled();
  });

  it('should preserve cancellation identity when the status probe is interrupted', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-terminate-cancel-'),
    );
    const { sprite, execute, client, request } =
      await createTerminationBoundary(directory.path);
    await sprite
      .filesystem()
      .mkdir(dirname(TAILSCALE_STATE_FILE), { recursive: true });
    await sprite.filesystem().writeFile(TAILSCALE_STATE_FILE, 'enrolled');
    const cancelled = new InteractionExit('cancel');
    execute.mockRejectedValueOnce(cancelled);

    await expect(
      terminateWorkstation(dependencies, {
        request,
        provider: providerOf(client),
      }),
    ).rejects.toBe(cancelled);
    expect(client.deleteSprite).not.toHaveBeenCalled();
  });
});
