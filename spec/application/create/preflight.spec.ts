import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { prepareCreate } from '#application/create/preflight';

import { driveInk } from '../../fixtures/ink';

import { dependencies } from '../../mocks/dependencies';

import type { CommandOptions, CommandRequest } from '#application/contracts';

const request = {
  command: 'create',
  options: {
    name: 'saf07-generated',
    provider: 'sprite',
    cpu: 2,
    mem: 2,
    release: 'stable',
    localCredentials: false,
    github: false,
    plugins: false,
    gitIdentity: false,
    harness: ['claude', 'codex'],
    network: 'none',
    proxy: false,
    idleMinutes: 5,
  },
} satisfies CommandRequest;

/** an organization-scoped token in the shape the Sprites API issues */
const ORGANIZATION_TOKEN = 'saf07-org/1234/0123abcd/4567ef89';

describe('fn:prepareCreate consent', () => {
  it('should report rejected provider authentication without creating a workstation', async () => {
    vi.stubEnv('SPRITES_TOKEN', ORGANIZATION_TOKEN);
    vi.spyOn(SpritesClient.prototype, 'listAllSprites').mockRejectedValueOnce(
      new Error('Provider unavailable'),
    );

    const result = await prepareCreate(dependencies, {
      ...request,
      options: { ...request.options, yes: true, githubHost: 'github.com' },
    });

    expect(result).toMatchObject({
      kind: 'result',
      result: {
        ok: false,
        error: { details: [expect.stringContaining('Provider unavailable')] },
      },
    });
  });

  it('should report a rejected network probe as a provisioning blocker', async () => {
    vi.stubEnv('SPRITES_TOKEN', ORGANIZATION_TOKEN);
    vi.spyOn(SpritesClient.prototype, 'listAllSprites').mockResolvedValue([]);
    const preflight = vi.fn(async () => {
      throw new Error('network probe rejected');
    });
    const registry = {
      ...dependencies.registry,
      networks: {
        ...dependencies.registry.networks,
        none: { ...dependencies.registry.networks.none, preflight },
      },
    } satisfies typeof dependencies.registry;

    const result = await prepareCreate(
      { ...dependencies, registry },
      {
        ...request,
        options: { ...request.options, yes: true },
      },
    );

    expect(result).toMatchObject({
      kind: 'result',
      result: {
        ok: false,
        error: { details: [expect.stringContaining('network probe rejected')] },
      },
    });
  });

  it('should preserve a name collision as a conflict', async () => {
    vi.stubEnv('SPRITES_TOKEN', ORGANIZATION_TOKEN);
    const sprite = Object.assign(
      new Sprite('saf07-generated', new SpritesClient(ORGANIZATION_TOKEN)),
      { id: 'existing-id' },
    );
    vi.spyOn(SpritesClient.prototype, 'listAllSprites').mockImplementation(
      async () => [sprite],
    );

    const result = await prepareCreate(dependencies, {
      ...request,
      options: { ...request.options, yes: true },
    });

    expect(result).toMatchObject({
      kind: 'result',
      result: {
        ok: false,
        error: { code: 'CONFLICT', machine: 'saf07-generated' },
      },
    });
  });

  it('should return cancellation when consent is interrupted before provisioning', async () => {
    vi.stubEnv('SPRITES_TOKEN', ORGANIZATION_TOKEN);
    vi.spyOn(SpritesClient.prototype, 'listAllSprites').mockImplementation(
      async () => [],
    );
    const observed = await driveInk(
      async (interaction) =>
        prepareCreate(
          dependencies,
          {
            ...request,
            options: {
              ...request.options,
              githubHost: 'enterprise.example.test',
            },
          },
          interaction,
        ),
      [{ waitFor: 'Create saf07-generated on Fly Sprite', input: '\u0003' }],
    );

    expect(observed.result).toMatchObject({
      kind: 'result',
      result: { ok: false, error: { code: 'CANCELLED' } },
    });
  });

  it.each([
    { usesExitNode: false, management: true, effectiveExitNode: undefined },
    { usesExitNode: true, management: true, effectiveExitNode: '100.64.0.1' },
    { usesExitNode: true, management: false, effectiveExitNode: 'exit' },
  ])(
    'should carry network enrollment and the available exit route into provisioning: %j',
    async ({ usesExitNode, management, effectiveExitNode }) => {
      vi.stubEnv('SPRITES_TOKEN', ORGANIZATION_TOKEN);
      vi.stubEnv('TAILSCALE_AUTH_KEY', 'supplied-enrollment-key');
      vi.stubEnv(
        'TAILSCALE_API_KEY',
        management ? 'network-management-key' : undefined,
      );
      vi.stubEnv('TAILSCALE_TAILNET', 'example.ts.net');
      vi.spyOn(SpritesClient.prototype, 'listAllSprites').mockImplementation(
        async () => [],
      );
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async () =>
          Response.json({
            devices: [
              {
                id: 'exit-id',
                name: 'exit.example.ts.net',
                hostname: 'exit',
                addresses: ['100.64.0.1'],
                enabledRoutes: ['0.0.0.0/0'],
              },
            ],
          }),
        ),
      );

      const result = await prepareCreate(dependencies, {
        ...request,
        options: {
          ...request.options,
          network: 'tailscale',
          useExitNode: usesExitNode,
          ...(usesExitNode ? { exitNode: 'exit' } : {}),
          yes: true,
        },
      });

      expect(result).toMatchObject({
        kind: 'ready',
        context: {
          effectiveExitNode,
          authKey: expect.anything(),
        },
      });
    },
  );

  it('should report network preflight problems before provisioning', async () => {
    vi.stubEnv('SPRITES_TOKEN', ORGANIZATION_TOKEN);
    vi.stubEnv('TAILSCALE_AUTH_KEY', 'supplied-enrollment-key');
    vi.stubEnv('TAILSCALE_API_KEY', 'network-management-key');
    vi.stubEnv('TAILSCALE_TAILNET', 'example.ts.net');
    vi.spyOn(SpritesClient.prototype, 'listAllSprites').mockImplementation(
      async () => [],
    );
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response('', { status: 403 })),
    );

    const result = await prepareCreate(dependencies, {
      ...request,
      options: {
        ...request.options,
        network: 'tailscale',
        useExitNode: false,
        yes: true,
      },
    });

    expect(result).toMatchObject({
      kind: 'result',
      result: {
        ok: false,
        error: {
          code: 'AUTH',
          details: [expect.stringContaining('returned 403')],
        },
      },
    });
  });

  it('should aggregate a missing name and token with every local token recovery route before provider access', async () => {
    const home = await mkdtemp(join(tmpdir(), 'open-agent-cor07-create-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('SPRITES_TOKEN', undefined);

    try {
      const prepared = await prepareCreate(dependencies, {
        ...request,
        options: {
          ...request.options,
          name: undefined,
          nonInteractive: true,
          yes: true,
        },
      });

      expect(prepared).toMatchObject({
        kind: 'result',
        result: { command: 'create', ok: false, error: { code: 'INPUT' } },
      });
      if (prepared.kind !== 'result' || prepared.result.ok) {
        throw new Error('Expected incomplete local preflight');
      }
      const details = prepared.result.error.details ?? [];
      expect(details).toEqual([
        expect.stringContaining('--name'),
        expect.stringContaining('SPRITES_TOKEN'),
      ]);
      for (const route of [
        '--credential-file FILE',
        'env:NAME, file:PATH, or keychain:SERVICE/ACCOUNT',
        'TTY',
        'https://sprites.dev/account',
        'intended organization',
      ]) {
        expect(details.join(' ')).toContain(route);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('should require real Ink consent before provisioning a selected workstation', async () => {
    vi.stubEnv('SPRITES_TOKEN', ORGANIZATION_TOKEN);
    const list = vi.fn<SpritesClient['listAllSprites']>(async () => []);
    vi.spyOn(SpritesClient.prototype, 'listAllSprites').mockImplementation(
      list,
    );
    const observed = await driveInk(
      async (interaction) => prepareCreate(dependencies, request, interaction),
      [
        {
          waitFor: 'Create saf07-generated on Fly Sprite',
          input: 'n',
        },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(1);
    expect(observed.result).toMatchObject({
      kind: 'result',
      result: { command: 'create', ok: false, error: { code: 'CANCELLED' } },
    });
    expect(list).toHaveBeenCalledOnce();
  });

  it('should bypass only the selected provision consent under --yes', async () => {
    vi.stubEnv('SPRITES_TOKEN', ORGANIZATION_TOKEN);
    const list = vi.fn<SpritesClient['listAllSprites']>(async () => []);
    vi.spyOn(SpritesClient.prototype, 'listAllSprites').mockImplementation(
      list,
    );
    const observed = await driveInk(
      async (interaction) =>
        prepareCreate(
          dependencies,
          {
            ...request,
            options: { ...request.options, yes: true },
          },
          interaction,
        ),
      [],
    );

    expect(observed.matchedSteps).toBe(0);
    expect(observed.result).toMatchObject({ kind: 'ready' });
    expect(list).toHaveBeenCalledOnce();
  });

  it('should still collects a missing workstation name under --yes', async () => {
    vi.stubEnv('SPRITES_TOKEN', ORGANIZATION_TOKEN);
    const list = vi.fn<SpritesClient['listAllSprites']>(async () => []);
    vi.spyOn(SpritesClient.prototype, 'listAllSprites').mockImplementation(
      list,
    );
    const optionsWithoutName: CommandOptions = { ...request.options };
    delete optionsWithoutName.name;
    const observed = await driveInk(
      async (interaction) =>
        prepareCreate(
          dependencies,
          {
            ...request,
            options: { ...optionsWithoutName, yes: true },
          },
          interaction,
        ),
      [
        { waitFor: 'Workstation name', input: 'saf07-prompted' },
        { waitFor: 'saf07-prompted', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(2);
    expect(observed.result).toMatchObject({
      kind: 'ready',
      context: { name: 'saf07-prompted' },
    });
    expect(list).toHaveBeenCalledOnce();
  });

  it('should refuse a Fly API token offline with its fix before any provider call', async () => {
    vi.stubEnv('SPRITES_TOKEN', 'FlyV1 fm2_generated-macaroon');
    const list = vi.spyOn(SpritesClient.prototype, 'listAllSprites');

    const prepared = await prepareCreate(dependencies, {
      ...request,
      options: { ...request.options, nonInteractive: true, yes: true },
    });

    expect(prepared).toMatchObject({
      kind: 'result',
      result: {
        ok: false,
        error: {
          code: 'INPUT',
          message: 'Provider prerequisites are missing or misconfigured',
          details: [
            expect.stringMatching(
              /holds a Fly API token.*https:\/\/sprites\.dev\/account/,
            ),
          ],
        },
      },
    });
    expect(list).not.toHaveBeenCalled();
  });
});
