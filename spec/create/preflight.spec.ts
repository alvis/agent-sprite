import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { prepareCreate } from '#create/preflight';

import { driveInk } from '../fixtures/ink';

import type { Sprite } from '@fly/sprites';

import type { CommandRequest } from '#command/contracts';

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
  it('should aggregate a missing name and token with every local token recovery route before provider access', async () => {
    const home = await mkdtemp(join(tmpdir(), 'open-agent-cor07-create-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('SPRITES_TOKEN', undefined);

    try {
      const prepared = await prepareCreate({
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
        '--env-file FILE',
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
    const list = vi
      .spyOn(SpritesClient.prototype, 'listAllSprites')
      .mockResolvedValue([] as Sprite[]);
    const observed = await driveInk(
      async (interaction) => prepareCreate(request, interaction),
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
    const list = vi
      .spyOn(SpritesClient.prototype, 'listAllSprites')
      .mockResolvedValue([] as Sprite[]);
    const observed = await driveInk(
      async (interaction) =>
        prepareCreate(
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
    const list = vi
      .spyOn(SpritesClient.prototype, 'listAllSprites')
      .mockResolvedValue([] as Sprite[]);
    const observed = await driveInk(
      async (interaction) =>
        prepareCreate(
          {
            ...request,
            options: { ...request.options, name: undefined, yes: true },
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

    const prepared = await prepareCreate({
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
