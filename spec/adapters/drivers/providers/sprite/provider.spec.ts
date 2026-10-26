import { Sprite, SpriteCommand, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { sprite as unboundProvider } from '#adapters/drivers/providers/sprite';
import {
  MANAGED_LABEL,
  SCHEMA_LABEL,
  SETUP_INCOMPLETE_LABEL,
  SETUP_READY_LABEL,
  profileSummaryLabels,
} from '#adapters/drivers/providers/sprite/labels';

import { OperationContext, withOperation } from '#kernel/operation';

import {
  DEFAULT_AGENT_PORT,
  DISABLED_NETWORK_PROFILE,
  DISABLED_NETWORK_SUMMARY,
} from '../../../../fixtures/profile';

import { providerOf } from '../../../../mocks/sprites';

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
const provider = providerOf(client);

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

/**
 * binds a provider to one observed Sprite handle
 * @param sprite handle returned by lookups
 * @returns provider using the supplied observation
 */
function providerWithSprite(sprite: Sprite) {
  const observedClient = Object.assign(new SpritesClient('test-token'), {
    getSprite: vi.fn<SpritesClient['getSprite']>(async () => sprite),
  } satisfies Partial<SpritesClient>);

  return providerOf(observedClient);
}

describe('mt:SpriteProvider.preflight', () => {
  it('should report a missing Sprites credential and reject a Fly API token offline', async () => {
    const host = {
      findTool: async () => undefined,
      readVersion: async () => undefined,
    };

    const missing = await unboundProvider.preflight(host);
    const refused = await unboundProvider.preflight({
      ...host,
      credential: 'FlyV1 wrong-provider-token',
      credentialSource: 'test input',
    });

    expect(missing).toEqual([
      expect.objectContaining({ subject: 'SPRITES_TOKEN' }),
    ]);
    expect(refused).toEqual([
      expect.objectContaining({
        subject: 'SPRITES_TOKEN',
        problem: expect.stringContaining('Fly API token'),
      }),
    ]);
  });
});

describe('mt:SpriteProvider.list', () => {
  it('should map both provider pages and exclude workstations without the ownership label', async () => {
    const workstations = await provider.list();

    expect(workstations).toEqual([
      {
        id: 'sprite-primary',
        name: 'primary',
        organization: 'test-organization',
        createdAt: createdAt.toISOString(),
        state: 'running',
        url: primaryInfo.url,
        machine: { cpus: 8, label: 'sprite', memoryGb: 16 },
        metadata: { setup: 'not recorded' },
      },
      {
        id: 'sprite-second',
        name: 'second',
        organization: 'test-organization',
        createdAt: createdAt.toISOString(),
        state: 'cold',
        url: primaryInfo.url,
        machine: { cpus: 8, label: 'sprite', memoryGb: 16 },
        metadata: { setup: 'not recorded' },
      },
    ]);
    expect(boundary.listSprites.mock.calls).toEqual([
      [{ prefix: undefined, maxResults: 50, continuationToken: undefined }],
      [{ prefix: undefined, maxResults: 50, continuationToken: 'next-page' }],
    ]);
  });

  it('should reject every call before a credential is bound', async () => {
    await expect(unboundProvider.list()).rejects.toMatchObject({
      code: 'authentication',
      message: 'SPRITES_TOKEN is required.',
    });
  });
});

describe('mt:SpriteProvider.isNameTaken', () => {
  it('should reserve unmanaged names and leave absent names available', async () => {
    expect(await provider.isNameTaken('unmanaged')).toBe(true);
    expect(await provider.isNameTaken('available')).toBe(false);
  });
});

describe('mt:SpriteProvider.create', () => {
  it('should request private access and management labels on the new provider handle', async () => {
    const workstation = await provider.create(
      'created',
      DISABLED_NETWORK_PROFILE,
      DEFAULT_AGENT_PORT,
    );

    expect(workstation).toMatchObject({
      name: 'created',
      metadata: { setup: 'not recorded', profile: DISABLED_NETWORK_SUMMARY },
    });
    expect(boundary.createSprite).toHaveBeenLastCalledWith('created', {
      labels: [
        MANAGED_LABEL,
        SCHEMA_LABEL,
        ...profileSummaryLabels(DISABLED_NETWORK_SUMMARY),
      ],
      urlSettings: { auth: 'sprite' },
    });
  });

  it('should retain the original failure and identify the visible owned resource', async () => {
    const failure = new Error('provider timeout');
    boundary.createSprite.mockRejectedValueOnce(failure);

    await expect(
      provider.create('primary', DISABLED_NETWORK_PROFILE, DEFAULT_AGENT_PORT),
    ).rejects.toMatchObject({
      name: 'WorkstationCreationFault',
      message:
        'Sprite creation failed after primary became visible; a managed resource was retained and setup is incomplete',
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

    await expect(
      provider.create('primary', DISABLED_NETWORK_PROFILE, DEFAULT_AGENT_PORT),
    ).rejects.toMatchObject({
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
        provider.create(
          'primary',
          DISABLED_NETWORK_PROFILE,
          DEFAULT_AGENT_PORT,
        ),
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
      async () =>
        provider.create(
          'primary',
          DISABLED_NETWORK_PROFILE,
          DEFAULT_AGENT_PORT,
        ),
    );

    await vi.waitFor(() => expect(rejectCreate).toBeTypeOf('function'));
    expect(boundary.getSprite.mock.calls).toHaveLength(lookupsBefore);
    controller.abort();
    expect(boundary.getSprite.mock.calls).toHaveLength(lookupsBefore);
    rejectCreate?.(new Error('provider settled after cancellation'));

    await expect(operation).rejects.toMatchObject({
      name: 'WorkstationCreationFault',
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

    await expect(
      provider.create('primary', DISABLED_NETWORK_PROFILE, DEFAULT_AGENT_PORT),
    ).rejects.toMatchObject({
      outcome: 'unknown',
      machine: 'primary',
      machineId: undefined,
    });
  });
});

describe('mt:SpriteProvider.get', () => {
  it('should require provider identity, organization, and the ownership label before accepting a target', async () => {
    for (const fields of [
      { id: '' },
      { organizationName: '' },
      { labels: ['unrelated'] },
    ]) {
      boundary.getSprite.mockResolvedValueOnce(createProviderSprite(fields));

      await expect(provider.get('primary')).rejects.toMatchObject({
        code: 'ownership-mismatch',
        message: 'Sprite primary is not a verified open-agent workstation',
      });
    }

    expect(await provider.get('primary')).toMatchObject({
      id: 'sprite-primary',
      organization: 'test-organization',
    });
  });
});

describe('mt:SpriteProvider.delete', () => {
  it('should refuse changed IDs and organizations before deleting the exact validated name', async () => {
    const expected = await provider.get('primary');
    boundary.getSprite.mockResolvedValueOnce(
      createProviderSprite({ id: 'replacement' }),
    );

    await expect(provider.delete(expected)).rejects.toMatchObject({
      code: 'ownership-mismatch',
      message:
        'Sprite primary changed identity or organization before deletion',
    });
    expect(boundary.deleteSprite.mock.calls).toEqual([]);

    boundary.getSprite.mockResolvedValueOnce(
      createProviderSprite({ organizationName: 'another-organization' }),
    );

    await expect(provider.delete(expected)).rejects.toMatchObject({
      code: 'ownership-mismatch',
    });
    expect(boundary.deleteSprite.mock.calls).toEqual([]);

    await provider.delete(expected);

    expect(boundary.deleteSprite.mock.calls).toEqual([['primary']]);
  });
});

describe('mt:SpriteProvider.setMetadata', () => {
  it('should replace setup state without losing unrelated labels or adding duplicates', async () => {
    const sprite = createProviderSprite({
      labels: [
        ...primaryInfo.labels,
        SETUP_INCOMPLETE_LABEL,
        SETUP_READY_LABEL,
      ],
    });
    const subject = providerWithSprite(sprite);
    const workstation = await subject.get('primary');

    const updated = await subject.setMetadata(workstation, {
      setup: 'ready',
    });

    expect(sprite.labels).toEqual([...primaryInfo.labels, SETUP_READY_LABEL]);
    expect(updated.metadata).toEqual({ setup: 'ready' });
  });

  it('should reject an unmanaged target before changing labels', async () => {
    const unmanaged = createProviderSprite({ labels: [] });
    const subject = providerWithSprite(unmanaged);
    const workstation = await providerWithSprite(createProviderSprite()).get(
      'primary',
    );

    await expect(
      subject.setMetadata(workstation, { setup: 'ready' }),
    ).rejects.toMatchObject({ code: 'ownership-mismatch' });
    expect(unmanaged.update).not.toHaveBeenCalled();
  });
});

describe('mt:SpriteProvider.expose', () => {
  it('should expose a managed URL and restore provider authentication for private visibility', async () => {
    const sprite = createProviderSprite();
    const subject = providerWithSprite(sprite);
    const workstation = await subject.get('primary');

    await subject.expose(workstation, 3773, 'public');

    expect(sprite.urlSettings).toEqual({ auth: 'public' });

    await subject.expose(workstation, 3773, 'private');

    expect(sprite.urlSettings).toEqual({ auth: 'sprite' });
  });
});

describe('mt:SpriteProvider.resize', () => {
  it('should keep the same workstation because a Sprite has no configurable size', async () => {
    const workstation = await provider.get('primary');

    expect(await unboundProvider.resize(workstation)).toBe(workstation);
  });
});

describe('mt:SpriteProvider.openGuest', () => {
  it('should share one guest channel for repeated opens of a workstation', async () => {
    const subject = providerWithSprite(createProviderSprite());
    const workstation = await subject.get('primary');

    const first = await subject.openGuest(workstation);
    const second = await subject.openGuest(workstation);

    expect(second).toBe(first);
  });

  it('should refetch an external record and reject it when its immutable identity changed', async () => {
    const workstation = await providerWithSprite(createProviderSprite()).get(
      'primary',
    );
    const matched = createProviderSprite();
    const execute = vi.spyOn(matched, 'execFile').mockResolvedValue({
      exitCode: 0,
      stdout: 'refetched\n',
      stderr: '',
    });

    const channel = await providerWithSprite(matched).openGuest(workstation);
    const result = await channel.exec({
      program: '/bin/true',
      arguments: [],
    });

    expect(result).toMatchObject({ exitCode: 0, stdout: 'refetched\n' });
    expect(execute).toHaveBeenCalledOnce();

    const changed = providerWithSprite(
      createProviderSprite({ id: 'replacement' }),
    );
    await expect(changed.openGuest(workstation)).rejects.toMatchObject({
      code: 'ownership-mismatch',
    });
  });
});

describe('mt:SpriteProvider.openRootShell', () => {
  it('should start the requested shell through the Sprite privileged exec boundary', async () => {
    const sprite = createProviderSprite();
    const command = new SpriteCommand(sprite, '/usr/bin/sudo', [
      '-n',
      '-E',
      '--',
      '/bin/sh',
    ]);
    const spawn = vi.spyOn(sprite, 'spawn').mockReturnValue(command);
    const subject = providerWithSprite(sprite);
    const workstation = await subject.get('primary');

    const shell = await subject.openRootShell(workstation, '/bin/sh');

    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/sudo',
      ['-n', '-E', '--', '/bin/sh'],
      { tty: false },
    );
    expect(shell.stdout).toBe(command.stdout);
  });
});

describe('mt:SpriteProvider.awaitGuestReady', () => {
  it('should return without a boot probe because Sprite exec performs its wake-up', async () => {
    const workstation = await provider.get('primary');

    await expect(
      unboundProvider.awaitGuestReady(workstation),
    ).resolves.toBeUndefined();
  });
});

describe('mt:SpriteProvider.authenticate', () => {
  it('should bind a client with the Sprites API base URL and credential', () => {
    expect(
      unboundProvider.authenticate({
        credential: 'credential',
        restorableServices: [],
      }),
    ).not.toBe(unboundProvider);
  });
});
