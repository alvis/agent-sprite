import { Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import {
  MANAGED_LABEL,
  SCHEMA_LABEL,
  VERSION_LABEL_PREFIX,
} from '#adapters/drivers/providers/sprite/labels';
import { listWorkstations, selectManagedMachine } from '#application/inspect';

import { driveInk } from '../fixtures/ink';
import { dependencies } from '../mocks/dependencies';
import { providerOf } from '../mocks/sprites';

import type { ProviderAvailability } from '#application/inspect';

/**
 * a real provider adapter backed by controlled Sprite SDK list and get calls
 * @param listed sprites returned by the list call
 * @param fetched optional sprite returned by lookup, defaulting to the first
 * listed sprite
 */
function spritesOf(
  listed: Sprite[],
  fetched = listed[0],
): {
  client: SpritesClient;
  provider: ReturnType<typeof providerOf>;
} {
  const client = new SpritesClient('test-org/1/0abc/0def');
  vi.spyOn(client, 'listAllSprites').mockImplementation(async () => listed);
  vi.spyOn(client, 'getSprite').mockImplementation(async () => {
    if (!fetched) {
      throw new Error('No Sprite was configured for lookup');
    }

    return fetched;
  });

  return { client, provider: providerOf(client) };
}

/**
 * an SDK record with the immutable identity a managed Sprite reports
 * @param name sprite name used for its managed identity and URL
 * @param labels optional labels, defaulting to the managed and schema labels
 */
function spriteOf(
  name: string,
  labels = [MANAGED_LABEL, SCHEMA_LABEL],
): Sprite {
  const client = new SpritesClient('test-org/1/0abc/0def');

  return Object.assign(new Sprite(name, client), {
    id: `sprite-${name}`,
    organizationName: 'test-org',
    labels,
    url: `https://${name}.sprites.app`,
    status: 'running',
  });
}

describe('fn:listWorkstations', () => {
  it('should merge live managed machines and mark a newer release without opening a guest', async () => {
    const current = spriteOf('current');
    const newer = spriteOf('newer', [
      MANAGED_LABEL,
      SCHEMA_LABEL,
      `${VERSION_LABEL_PREFIX}999-0-0`,
    ]);
    const unrelated = spriteOf('unrelated', []);
    const { client, provider } = spritesOf([current, newer, unrelated]);
    const openGuest = vi.spyOn(provider, 'openGuest');

    const result = await listWorkstations(dependencies, [
      { id: 'sprite', driver: provider },
    ]);

    expect(result).toMatchObject({
      command: 'list',
      ok: true,
      data: {
        machines: [
          {
            provider: 'sprite',
            id: 'sprite-current',
            name: 'current',
            readiness: 'not inspected',
          },
          {
            provider: 'sprite',
            id: 'sprite-newer',
            name: 'newer',
            newerRelease: '999.0.0',
          },
        ],
        unavailable: [],
      },
    });
    expect(result).toHaveProperty('data.machines.0.newerRelease', undefined);
    expect(client.listAllSprites).toHaveBeenCalledOnce();
    expect(client.getSprite).not.toHaveBeenCalled();
    expect(openGuest).not.toHaveBeenCalled();
  });

  it('should keep an unavailable provider visible when another provider answers with an empty list', async () => {
    const { client, provider } = spritesOf([]);

    const result = await listWorkstations(dependencies, [
      { id: 'sprite', driver: provider },
      { id: 'fly-machine', code: 'AUTH', reason: 'Credential missing' },
    ]);

    expect(result).toMatchObject({
      command: 'list',
      ok: true,
      data: {
        machines: [],
        unavailable: [
          {
            provider: 'fly-machine',
            code: 'AUTH',
            reason: 'Credential missing',
          },
        ],
      },
    });
    expect(client.listAllSprites).toHaveBeenCalledOnce();
    expect(client.getSprite).not.toHaveBeenCalled();
  });

  it('should preserve a shared failure code when no provider can be queried', async () => {
    const unavailable: ProviderAvailability[] = [
      { id: 'sprite', code: 'AUTH', reason: 'Sprite token missing' },
      { id: 'fly-machine', code: 'AUTH', reason: 'Fly token missing' },
    ];

    await expect(
      listWorkstations(dependencies, unavailable),
    ).resolves.toMatchObject({
      command: 'list',
      ok: false,
      error: {
        code: 'AUTH',
        details: [
          'sprite: Sprite token missing',
          'fly-machine: Fly token missing',
        ],
      },
    });
  });

  it('should use a general provider failure for mixed provider codes', async () => {
    const mixed: ProviderAvailability[] = [
      { id: 'sprite', code: 'AUTH', reason: 'Sprite token missing' },
      { id: 'fly-machine', code: 'PREFLIGHT', reason: 'Fly setup failed' },
    ];

    await expect(listWorkstations(dependencies, mixed)).resolves.toMatchObject({
      command: 'list',
      ok: false,
      error: {
        code: 'PROVIDER',
        details: expect.arrayContaining(['fly-machine: Fly setup failed']),
      },
    });
  });

  it('should report that no provider could be queried when none is available', async () => {
    await expect(listWorkstations(dependencies, [])).resolves.toMatchObject({
      command: 'list',
      ok: false,
      error: { code: 'PROVIDER', details: [] },
    });
  });

  it('should report an SDK list failure as an unavailable provider', async () => {
    const { client, provider } = spritesOf([]);
    vi.mocked(client.listAllSprites).mockRejectedValueOnce(
      new Error('SDK list failed'),
    );

    const result = await listWorkstations(dependencies, [
      { id: 'sprite', driver: provider },
    ]);

    expect(result).toMatchObject({
      command: 'list',
      ok: false,
      error: {
        code: 'UNEXPECTED',
        details: ['sprite: SDK list failed'],
      },
    });
    expect(client.listAllSprites).toHaveBeenCalledOnce();
    expect(client.getSprite).not.toHaveBeenCalled();
  });
});

describe('fn:selectManagedMachine', () => {
  it('should require a name before querying a provider when interaction is unavailable', async () => {
    const { client, provider } = spritesOf([]);

    await expect(
      selectManagedMachine(dependencies, {
        provider,
        requestedName: undefined,
        release: 'metadata',
      }),
    ).rejects.toMatchObject({ code: 'INPUT' });
    expect(client.listAllSprites).not.toHaveBeenCalled();
    expect(client.getSprite).not.toHaveBeenCalled();
  });

  it('should report an empty managed list without asking for a selection', async () => {
    const { client, provider } = spritesOf([spriteOf('unrelated', [])]);
    const observed = await driveInk(
      async (interaction) =>
        selectManagedMachine(dependencies, {
          provider,
          requestedName: undefined,
          interaction,
          release: 'metadata',
        }).catch((error: unknown) => error),
      [],
    );

    expect(observed.result).toMatchObject({ code: 'PROVIDER' });
    expect(observed.matchedSteps).toBe(0);
    expect(client.listAllSprites).toHaveBeenCalledOnce();
    expect(client.getSprite).not.toHaveBeenCalled();
  });

  it('should fetch the chosen managed Sprite even when another choice lacks an ID', async () => {
    const missingId = Object.assign(spriteOf('missing-id'), { id: '' });
    const chosen = spriteOf('chosen');
    const { client, provider } = spritesOf([missingId, chosen], chosen);
    const observed = await driveInk(
      async (interaction) =>
        selectManagedMachine(dependencies, {
          provider,
          requestedName: undefined,
          interaction,
          release: 'metadata',
        }),
      [
        { waitFor: 'Select a workstation', input: 'chosen' },
        { waitFor: 'Search: chosen', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(2);
    expect(observed.result).toMatchObject({
      id: 'sprite-chosen',
      name: 'chosen',
      organization: 'test-org',
    });
    expect(client.listAllSprites).toHaveBeenCalledOnce();
    expect(client.getSprite).toHaveBeenCalledExactlyOnceWith('chosen');
  }, 15_000);
});
