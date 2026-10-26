import { describe, expect, it, vi } from 'vitest';

import {
  enterCommandCredential,
  resolveCommandCredential,
  retainAcceptedCredential,
} from '#application/workstation/credentials';

import { dependencies } from '../../mocks/dependencies';

import type { CommandRequest } from '#application/contracts';
import type { Interaction } from '#application/ports/interaction';
import type { CommandResult } from '#application/result';

const REQUEST = { command: 'list', options: {} } satisfies CommandRequest;
const SUCCESS = {
  command: 'list',
  ok: true,
  data: { machines: [], unavailable: [] },
} satisfies CommandResult;
const FAILURE = {
  command: 'list',
  ok: false,
  error: { code: 'INPUT', message: 'Provider rejected the token' },
} satisfies CommandResult;

/**
 * supplies the consent boundary while failing on unrelated prompts
 * @param consent whether the caller accepts local retention
 * @param token the credential returned when asked
 * @returns an interaction with observable consent and status calls
 */
function interactionOf(consent: boolean, token = '') {
  return {
    input: async () => '',
    secret: vi.fn<Interaction['secret']>(async () => token),
    select: async <V extends string>(): Promise<V> => {
      throw new Error('Unexpected selection prompt');
    },
    multiselect: async <V extends string>(): Promise<V[]> => {
      throw new Error('Unexpected multiple-choice prompt');
    },
    confirm: vi.fn<Interaction['confirm']>(async () => consent),
    progress: () => undefined,
    status: vi.fn<Interaction['status']>(() => undefined),
  } satisfies Interaction;
}

describe('fn:retainAcceptedCredential', () => {
  it('should save a newly accepted token only with consent and report storage without the token', async () => {
    const token = 'entered-management-secret';
    const save = vi.fn<typeof dependencies.host.credentials.save>(async () => ({
      storage: 'protected-file',
    }));
    const wired = {
      registry: dependencies.registry,
      host: {
        ...dependencies.host,
        credentials: { ...dependencies.host.credentials, save },
      },
    };
    const interaction = interactionOf(true);

    const result = await retainAcceptedCredential(wired, SUCCESS, {
      request: REQUEST,
      provider: 'sprite',
      credential: { token, isEntered: true },
      interaction,
    });

    expect(result).toEqual({
      ...SUCCESS,
      retainedCredential: { storage: 'protected-file' },
    });
    expect(save.mock.calls).toEqual([
      ['sprites', token, expect.objectContaining({ consent: true })],
    ]);
    expect(interaction.confirm).toHaveBeenCalledOnce();
    expect(interaction.status).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('should leave an accepted result unchanged when the caller declines storage', async () => {
    const save = vi.fn<typeof dependencies.host.credentials.save>(async () => ({
      storage: 'protected-file',
    }));
    const wired = {
      registry: dependencies.registry,
      host: {
        ...dependencies.host,
        credentials: { ...dependencies.host.credentials, save },
      },
    };
    const interaction = interactionOf(false);

    const result = await retainAcceptedCredential(wired, SUCCESS, {
      request: REQUEST,
      provider: 'sprite',
      credential: { token: 'entered-management-secret', isEntered: true },
      interaction,
    });

    expect(result).toEqual(SUCCESS);
    expect(save.mock.calls).toEqual([]);
    expect(interaction.status).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: 'the provider rejected it',
      result: FAILURE,
      credential: { token: 'entered-management-secret', isEntered: true },
      request: REQUEST,
      withInteraction: true,
    },
    {
      reason: 'the token came from an existing source',
      result: SUCCESS,
      credential: { token: 'stored-management-secret' },
      request: REQUEST,
      withInteraction: true,
    },
    {
      reason: 'nothing was entered',
      result: SUCCESS,
      credential: { isEntered: true },
      request: REQUEST,
      withInteraction: true,
    },
    {
      reason: 'the command is non-interactive',
      result: SUCCESS,
      credential: { token: 'entered-management-secret', isEntered: true },
      request: REQUEST,
      withInteraction: false,
    },
    {
      reason: 'local credentials are disabled',
      result: SUCCESS,
      credential: { token: 'entered-management-secret', isEntered: true },
      request: {
        command: 'list',
        options: { localCredentials: false },
      } satisfies CommandRequest,
      withInteraction: true,
    },
  ])(
    'should not offer storage when $reason',
    async ({ result, credential, request, withInteraction }) => {
      const save = vi.fn<typeof dependencies.host.credentials.save>(
        async () => ({ storage: 'protected-file' }),
      );
      const wired = {
        registry: dependencies.registry,
        host: {
          ...dependencies.host,
          credentials: { ...dependencies.host.credentials, save },
        },
      };
      const interaction = interactionOf(true);

      const retained = await retainAcceptedCredential(wired, result, {
        request,
        provider: 'sprite',
        credential,
        ...(withInteraction ? { interaction } : {}),
      });

      expect(retained).toEqual(result);
      expect(save.mock.calls).toEqual([]);
      expect(interaction.confirm).not.toHaveBeenCalled();
    },
  );
});

describe('fn:resolveCommandCredential', () => {
  it('should use a supplied provider token without prompting', async () => {
    const wired = {
      registry: dependencies.registry,
      host: {
        ...dependencies.host,
        environment: {
          ...dependencies.host.environment,
          variables: () => ({ SPRITES_TOKEN: 'supplied-provider-token' }),
        },
      },
    };
    const interaction = interactionOf(true);

    const credential = await resolveCommandCredential(wired, {
      request: REQUEST,
      provider: 'sprite',
      interaction,
    });

    expect(credential).toEqual({
      token: 'supplied-provider-token',
      source: 'SPRITES_TOKEN in the process environment',
    });
    expect(interaction.secret).not.toHaveBeenCalled();
  });

  it('should ask for a missing token and reject a known wrong provider shape', async () => {
    const token = 'entered-provider-token';
    const wired = {
      registry: dependencies.registry,
      host: {
        ...dependencies.host,
        environment: {
          ...dependencies.host.environment,
          variables: () => ({}),
        },
      },
    };
    const interaction = {
      ...interactionOf(true, token),
      secret: vi.fn<Interaction['secret']>(async (prompt) => {
        expect(prompt.validate?.('FlyV1 fm2_wrong')).toContain(
          'a Fly API token',
        );
        expect(prompt.validate?.(token)).toBeUndefined();

        return token;
      }),
    } satisfies Interaction;

    const credential = await resolveCommandCredential(wired, {
      request: { ...REQUEST, options: { localCredentials: false } },
      provider: 'sprite',
      interaction,
    });

    expect(credential).toEqual({
      token,
      source: 'the entered token',
      isEntered: true,
    });
    expect(interaction.secret).toHaveBeenCalledOnce();
  });
});

describe('fn:enterCommandCredential', () => {
  it.each([
    { reason: 'no interaction', withInteraction: false, options: {} },
    {
      reason: 'non-interactive mode',
      withInteraction: true,
      options: { nonInteractive: true },
    },
  ])(
    'should leave the credential absent with $reason',
    async ({ withInteraction, options }) => {
      const interaction = interactionOf(true, 'unused-token');
      const credential = await enterCommandCredential(dependencies, {
        request: { ...REQUEST, options },
        provider: 'sprite',
        ...(withInteraction ? { interaction } : {}),
      });

      expect(credential).toEqual({});
      expect(interaction.secret).not.toHaveBeenCalled();
    },
  );
});
