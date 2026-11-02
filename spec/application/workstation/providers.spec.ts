import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { locateProvider } from '#application/workstation/providers';

import { driveInk } from '../../fixtures/ink';
import { dependencies } from '../../mocks/dependencies';
import { createFilesystemSprite, workstationOf } from '../../mocks/sprites';

import type { ProviderDriver } from '#application/ports/drivers';
import type { ProviderId } from '#domain/ids';

// flyctl decoding is offline process I/O; prerequisite and token-scope logic stays real.
vi.mock(
  '#adapters/drivers/providers/fly-machine/flyctl',
  async (original) =>
    ({
      ...(await original<
        typeof import('#adapters/drivers/providers/fly-machine/flyctl')
      >()),
      decodeToken: async () =>
        JSON.stringify([
          {
            location: 'https://api.fly.io/v1',
            caveats: [{ type: 'Organization', body: { id: 1, mask: 'rwcdC' } }],
          },
          { location: 'https://api.fly.io/aaa/v1', caveats: [] },
        ]),
    }) satisfies Partial<
      typeof import('#adapters/drivers/providers/fly-machine/flyctl')
    >,
);

const workstation = workstationOf(
  createFilesystemSprite({ root: tmpdir() }),
).workstation;
const options = { localCredentials: false };
const failure = new Error('Provider inventory unavailable');

/**
 * supplies provider inventory I/O while keeping both registered preflights real
 * @param inventories records or failures returned by each provider
 * @returns dependencies with isolated management boundaries
 */
function inventoriesOf(
  inventories: Record<ProviderId, Array<typeof workstation> | Error>,
) {
  const inventory = (id: ProviderId) =>
    ({
      list: async () => {
        const result = inventories[id];
        if (result instanceof Error) {
          throw result;
        }

        return result;
      },
      get: async () => {
        const result = inventories[id];
        if (result instanceof Error) {
          throw result;
        }
        const [record] = result;
        if (!record) {
          throw Object.assign(new Error('No workstation'), {
            code: 'not-found',
          });
        }

        return record;
      },
    }) satisfies Partial<ProviderDriver>;

  return {
    registry: {
      ...dependencies.registry,
      providers: {
        'sprite': {
          ...dependencies.registry.providers.sprite,
          preflight: dependencies.registry.providers.sprite.preflight.bind(
            dependencies.registry.providers.sprite,
          ),
          authenticate: () => ({
            ...dependencies.registry.providers.sprite,
            ...inventory('sprite'),
          }),
        },
        'fly-machine': {
          ...dependencies.registry.providers['fly-machine'],
          preflight: dependencies.registry.providers[
            'fly-machine'
          ].preflight.bind(dependencies.registry.providers['fly-machine']),
          authenticate: () => ({
            ...dependencies.registry.providers['fly-machine'],
            ...inventory('fly-machine'),
          }),
        },
      },
    },
    host: {
      ...dependencies.host,
      environment: {
        ...dependencies.host.environment,
        variables: () => ({
          SPRITES_TOKEN: 'organization/1234/0123abcd/4567ef89',
          FLY_API_TOKEN: 'FlyV1 fm2_test',
        }),
      },
      tools: {
        ...dependencies.host.tools,
        findTool: async () => '/isolated/fly',
      },
      run: async () => 'fly v0.4.108 darwin/arm64',
    },
  } satisfies Pick<typeof dependencies, 'registry' | 'host'>;
}

describe('fn:locateProvider', () => {
  it.each([
    {
      machine: 'workstation',
      sprite: [workstation],
      fly: [],
      expected: 'sprite',
    },
    { machine: 'workstation', sprite: [], fly: [], expected: undefined },
    { sprite: [], fly: [], expected: undefined },
  ])(
    'should locate a sole holder or leave an empty inventory unresolved ($machine, $expected)',
    async ({ machine, sprite, fly, expected }) => {
      const wired = inventoriesOf({ sprite, 'fly-machine': fly });

      await expect(
        locateProvider(wired, { command: 'show', machine, options }),
      ).resolves.toBe(expected);
    },
  );

  it('should use the remaining ready provider when another lacks its host tool', async () => {
    const wired = inventoriesOf({ 'sprite': [], 'fly-machine': [] });
    const unavailableFly = {
      ...wired,
      host: {
        ...wired.host,
        tools: { ...wired.host.tools, findTool: async () => undefined },
      },
    };

    await expect(
      locateProvider(unavailableFly, { command: 'show', options }),
    ).resolves.toBe('sprite');
  });

  it('should preserve an inventory failure when no provider can find the named workstation', async () => {
    const wired = inventoriesOf({ 'sprite': [], 'fly-machine': failure });

    await expect(
      locateProvider(wired, { command: 'show', machine: 'missing', options }),
    ).rejects.toEqual(failure);
  });

  it.each([
    { machine: 'workstation', identifier: 'workstation' },
    { machine: undefined, identifier: '--provider' },
  ])(
    'should require an explicit provider for ambiguous inventory (%s)',
    async ({ machine, identifier }) => {
      const wired = inventoriesOf({
        'sprite': [workstation],
        'fly-machine': [workstation],
      });

      await expect(
        locateProvider(wired, { command: 'show', machine, options }),
      ).rejects.toMatchObject({
        code: 'INPUT',
        message: expect.stringContaining(identifier),
      });
    },
  );

  it('should let an unnamed interactive request choose between providers', async () => {
    const wired = inventoriesOf({
      'sprite': [workstation],
      'fly-machine': [workstation],
    });

    const result = await driveInk(
      async (interaction) =>
        locateProvider(wired, { command: 'show', options }, interaction),
      [{ waitFor: 'Select a provider', input: ['\x1b[B', '\r'] }],
    );

    expect(result).toMatchObject({ result: 'sprite', matchedSteps: 1 });
  });
});
