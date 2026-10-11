import { Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import {
  MANAGED_LABEL,
  SCHEMA_LABEL,
  SETUP_INCOMPLETE_LABEL,
  SETUP_READY_LABEL,
  createManagedSprite,
  createSpritesClient,
  deleteManagedSprite,
  getManagedSprite,
  getSpriteUrl,
  listManagedSprites,
  setManagedSpriteLabels,
  setSpritePublic,
} from '#integrations/sprites';
import { OperationContext, withOperation } from '#operation';

import type {
  CreateSpriteOptions,
  SpriteConfig,
  SpriteInfo,
  SpriteList,
} from '@fly/sprites';

const createdAt = new Date('2026-10-01T12:00:00Z');
const sdkClient = new SpritesClient('test-token');
const primaryInfo = {
  id: 'sprite-primary',
  name: 'primary',
  organization: 'test-organization',
  status: 'running',
  createdAt,
  updatedAt: createdAt,
  labels: [MANAGED_LABEL, SCHEMA_LABEL, 'unrelated'],
  url: 'https://primary.sprites.app',
  urlSettings: { auth: 'sprite' },
  primaryRegion: 'lhr',
} satisfies SpriteInfo;
const pages = {
  first: {
    sprites: [
      primaryInfo,
      { ...primaryInfo, id: 'unmanaged', name: 'unmanaged', labels: [] },
    ],
    hasMore: true,
    nextContinuationToken: 'next-page',
  },
  next: {
    sprites: [
      { ...primaryInfo, id: 'sprite-second', name: 'second', status: 'cold' },
    ],
    hasMore: false,
  },
} satisfies Record<string, SpriteList>;
const boundary = {
  listSprites: vi.fn<SpritesClient['listSprites']>(async (options) =>
    options?.continuationToken ? pages.next : pages.first,
  ),
  getSprite: vi.fn<SpritesClient['getSprite']>(async () =>
    createProviderSprite(),
  ),
  deleteSprite: vi.fn<SpritesClient['deleteSprite']>(async () => undefined),
  createSprite: vi.fn(
    async (
      name: string,
      options?: SpriteConfig | CreateSpriteOptions,
    ): Promise<Sprite> => Object.assign(new Sprite(name, sdkClient), options),
  ),
} satisfies Partial<SpritesClient>;
const client = Object.assign(sdkClient, boundary);

/**
 * creates provider observations with independent mutable identity and label state
 * @param fields changed provider fields
 * @returns complete SDK Sprite handle
 */
function createProviderSprite(fields: Partial<Sprite> = {}): Sprite {
  const sprite = Object.assign(new Sprite(primaryInfo.name, client), {
    id: primaryInfo.id,
    organizationName: primaryInfo.organization,
    labels: [...primaryInfo.labels],
    url: primaryInfo.url,
    urlSettings: { ...primaryInfo.urlSettings },
    ...fields,
  });

  return Object.assign(sprite, {
    update: vi.fn<Sprite['update']>(async (options) => {
      Object.assign(sprite, options);

      return sprite;
    }),
    updateURLSettings: vi.fn<Sprite['updateURLSettings']>(async (settings) => {
      sprite.urlSettings = settings;
    }),
  } satisfies Partial<Sprite>);
}

describe('fn:listManagedSprites', () => {
  it('should map both provider pages and exclude workstations without the ownership label', async () => {
    const sprites = await listManagedSprites(client);

    expect(sprites).toMatchObject([
      {
        id: 'sprite-primary',
        name: 'primary',
        organizationName: 'test-organization',
        status: 'running',
        createdAt,
        url: primaryInfo.url,
        primaryRegion: 'lhr',
      },
      {
        id: 'sprite-second',
        name: 'second',
        organizationName: 'test-organization',
        status: 'cold',
        createdAt,
      },
    ]);
    expect(boundary.listSprites.mock.calls).toEqual([
      [{ prefix: undefined, maxResults: 50, continuationToken: undefined }],
      [{ prefix: undefined, maxResults: 50, continuationToken: 'next-page' }],
    ]);
  });
});

describe('fn:createManagedSprite', () => {
  it('should request private access and management labels on the new provider handle', async () => {
    const sprite = await createManagedSprite(client, 'created');

    expect(sprite).toMatchObject({
      name: 'created',
      labels: [MANAGED_LABEL, SCHEMA_LABEL],
      urlSettings: { auth: 'sprite' },
    });
    expect(createSpritesClient('credential')).toMatchObject({
      token: 'credential',
      baseURL: 'https://api.sprites.dev',
    });
  });

  it('should retain the original failure and identify the visible owned resource', async () => {
    const failure = new Error('provider timeout');
    boundary.createSprite.mockRejectedValueOnce(failure);

    await expect(createManagedSprite(client, 'primary')).rejects.toMatchObject({
      name: 'SpriteCreationOutcomeError',
      cause: failure,
      machine: 'primary',
      machineId: 'sprite-primary',
      outcome: 'retained',
      setupIncomplete: true,
    });
  });

  it('should report an unknown outcome when lookup fails or the visible resource lacks either ownership label', async () => {
    const failure = new Error('provider timeout');
    boundary.createSprite.mockRejectedValueOnce(failure);
    boundary.getSprite.mockRejectedValueOnce(new Error('lookup failed'));

    await expect(createManagedSprite(client, 'primary')).rejects.toMatchObject({
      cause: failure,
      machine: 'primary',
      outcome: 'unknown',
      setupIncomplete: undefined,
    });
    for (const labels of [[SCHEMA_LABEL], [MANAGED_LABEL]]) {
      boundary.createSprite.mockRejectedValueOnce(failure);
      boundary.getSprite.mockResolvedValueOnce(
        createProviderSprite({ labels }),
      );

      await expect(
        createManagedSprite(client, 'primary'),
      ).rejects.toMatchObject({
        cause: failure,
        machineId: 'sprite-primary',
        outcome: 'unknown',
        setupIncomplete: undefined,
      });
    }
  });

  it('should not infer absence before create settles and retains immutable identity after cancellation', async () => {
    let rejectCreate: ((reason: unknown) => void) | undefined;
    boundary.createSprite.mockImplementationOnce(
      async () =>
        new Promise<Sprite>((_resolve, reject) => {
          rejectCreate = reject;
        }),
    );
    boundary.getSprite.mockResolvedValueOnce(createProviderSprite());
    const lookupsBefore = boundary.getSprite.mock.calls.length;
    const controller = new AbortController();
    const operation = withOperation(
      new OperationContext({ signal: controller.signal }),
      async () => createManagedSprite(client, 'primary'),
    );

    await vi.waitFor(() => expect(rejectCreate).toBeTypeOf('function'));
    expect(boundary.getSprite.mock.calls).toHaveLength(lookupsBefore);
    controller.abort();
    expect(boundary.getSprite.mock.calls).toHaveLength(lookupsBefore);
    rejectCreate?.(new Error('provider settled after cancellation'));

    await expect(operation).rejects.toMatchObject({
      name: 'SpriteCreationOutcomeError',
      machine: 'primary',
      machineId: 'sprite-primary',
      outcome: 'retained',
      setupIncomplete: true,
      cause: { action: 'cancel' },
    });
    expect(boundary.getSprite.mock.calls).toHaveLength(lookupsBefore + 1);
  });

  it('should keep a message-shaped 404 lookup failure unknown', async () => {
    boundary.createSprite.mockRejectedValueOnce(
      new Error('provider create failed'),
    );
    boundary.getSprite.mockRejectedValueOnce(new Error('404 not found'));

    await expect(createManagedSprite(client, 'primary')).rejects.toMatchObject({
      outcome: 'unknown',
      machine: 'primary',
      machineId: undefined,
    });
  });
});

describe('fn:getManagedSprite', () => {
  it('should require provider identity, organization, and the ownership label before accepting a target', async () => {
    for (const fields of [
      { id: '' },
      { organizationName: '' },
      { labels: ['unrelated'] },
    ]) {
      boundary.getSprite.mockResolvedValueOnce(createProviderSprite(fields));

      await expect(getManagedSprite(client, 'primary')).rejects.toEqual(
        expect.objectContaining({ code: 'CONFLICT' }),
      );
    }

    expect(await getManagedSprite(client, 'primary')).toMatchObject({
      id: 'sprite-primary',
      organizationName: 'test-organization',
      labels: primaryInfo.labels,
    });
  });
});

describe('fn:deleteManagedSprite', () => {
  it('should refuse changed IDs and organizations before deleting the exact validated name', async () => {
    const expected = {
      name: 'primary',
      expectedId: 'sprite-primary',
      expectedOrganization: 'test-organization',
    };
    boundary.getSprite.mockResolvedValueOnce(
      createProviderSprite({ id: 'replacement' }),
    );

    await expect(deleteManagedSprite(client, expected)).rejects.toEqual(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
    expect(boundary.deleteSprite.mock.calls).toEqual([]);

    boundary.getSprite.mockResolvedValueOnce(
      createProviderSprite({ organizationName: 'another-organization' }),
    );

    await expect(deleteManagedSprite(client, expected)).rejects.toEqual(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
    expect(boundary.deleteSprite.mock.calls).toEqual([]);

    await deleteManagedSprite(client, expected);

    expect(boundary.deleteSprite.mock.calls).toEqual([['primary']]);
  });
});

describe('fn:setManagedSpriteLabels', () => {
  it('should replace setup state without losing unrelated labels or adding duplicates', async () => {
    const sprite = createProviderSprite({
      labels: [
        ...primaryInfo.labels,
        SETUP_INCOMPLETE_LABEL,
        SETUP_READY_LABEL,
      ],
    });

    const updated = await setManagedSpriteLabels(sprite, [
      SETUP_READY_LABEL,
      MANAGED_LABEL,
    ]);

    expect(updated.labels).toEqual([...primaryInfo.labels, SETUP_READY_LABEL]);
    await expect(
      setManagedSpriteLabels(createProviderSprite({ labels: [] }), [
        SETUP_READY_LABEL,
      ]),
    ).rejects.toEqual(expect.objectContaining({ code: 'CONFLICT' }));
  });
});

describe('fn:setSpritePublic', () => {
  it('should expose a managed URL and reject an unmanaged target before changing access', async () => {
    const sprite = createProviderSprite();
    const unmanaged = createProviderSprite({ labels: [] });

    await setSpritePublic(sprite);

    expect(sprite.urlSettings).toEqual({ auth: 'public' });
    await expect(setSpritePublic(unmanaged)).rejects.toEqual(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
    expect(unmanaged.urlSettings).toEqual({ auth: 'sprite' });
  });
});

describe('fn:getSpriteUrl', () => {
  it('should return the provider URL and reject a missing URL without synthesizing one', () => {
    expect(getSpriteUrl(createProviderSprite())).toBe(primaryInfo.url);
    expect(() => getSpriteUrl(createProviderSprite({ url: '' }))).toThrow(
      expect.objectContaining({ code: 'PROVIDER' }),
    );
  });
});
