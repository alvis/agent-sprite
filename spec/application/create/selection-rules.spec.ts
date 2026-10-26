import { SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { prepareCreate } from '#application/create/preflight';
import { registry } from '#composition/registry';

import { dependencies } from '../../mocks/dependencies';

import type { CommandRequest } from '#application/contracts';

// fixture catalog: the shipped agent replaced by a stand-in that drives only
// Claude and offers no pairing, the two rules no shipped driver can trigger
vi.mock('#composition/registry', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('#composition/registry')>();

  return {
    ...original,
    registry: {
      ...original.registry,
      agents: {
        t3: {
          ...original.registry.agents.t3,
          supportedHarnesses: ['claude'] as const,
          supportsPairing: false,
        },
      },
    },
  } satisfies typeof original;
});

const request = {
  command: 'create',
  options: {
    name: 'selection-rules',
    nonInteractive: true,
    yes: true,
    localCredentials: false,
    github: false,
    plugins: false,
    gitIdentity: false,
    harness: ['claude'],
    network: 'none',
    proxy: false,
  },
} satisfies CommandRequest;

/** an organization-scoped token in the shape the Sprites API issues */
const ORGANIZATION_TOKEN = 'selection-org/1234/0123abcd/4567ef89';

const providerCalls = vi.fn();

/** fails every provider boundary if selection reaches it */
function guardProviderBoundary(): void {
  vi.stubEnv('SPRITES_TOKEN', ORGANIZATION_TOKEN);
  vi.spyOn(registry.providers.sprite, 'authenticate').mockImplementation(
    (binding) => {
      providerCalls('authenticate', binding.restorableServices);

      throw new Error('provider bound');
    },
  );
  for (const method of [
    'listAllSprites',
    'createSprite',
    'getSprite',
  ] as const) {
    vi.spyOn(SpritesClient.prototype, method).mockImplementation(() => {
      providerCalls(method);

      throw new Error(`provider ${method}`);
    });
  }
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) => {
      providerCalls(
        'fetch',
        input instanceof Request ? input.url : input.toString(),
      );

      throw new Error('network request');
    }),
  );
}

describe('fn:prepareCreate selection rules', () => {
  it('should reject a harness the selected agent does not support before any provider call', async () => {
    guardProviderBoundary();
    await expect(
      prepareCreate(dependencies, {
        ...request,
        options: { ...request.options, harness: ['claude', 'codex'] },
      }),
    ).rejects.toMatchObject({
      code: 'INPUT',
      message: 'The workstation selection is invalid',
      details: ['ACP agent "t3" does not support harness "codex"'],
    });
    expect(providerCalls).not.toHaveBeenCalled();
  });

  it('should reject pairing from an agent that does not declare it before any provider call', async () => {
    guardProviderBoundary();
    await expect(
      prepareCreate(dependencies, {
        ...request,
        options: { ...request.options, withPairCode: true },
      }),
    ).rejects.toMatchObject({
      code: 'INPUT',
      message: 'The workstation selection is invalid',
      details: ['ACP agent "t3" does not support pairing (--with-pair-code)'],
    });
    expect(providerCalls).not.toHaveBeenCalled();
  });

  it('should aggregate both unreachable rules into one error before any provider call', async () => {
    guardProviderBoundary();
    await expect(
      prepareCreate(dependencies, {
        ...request,
        options: {
          ...request.options,
          harness: ['codex'],
          withPairCode: true,
        },
      }),
    ).rejects.toMatchObject({
      code: 'INPUT',
      details: [
        'ACP agent "t3" does not support harness "codex"',
        'ACP agent "t3" does not support pairing (--with-pair-code)',
      ],
    });
    expect(providerCalls).not.toHaveBeenCalled();
  });

  it('should reach the provider once the selection satisfies the stand-in agent', async () => {
    guardProviderBoundary();
    await expect(prepareCreate(dependencies, request)).rejects.toThrow(
      'provider bound',
    );
    expect(providerCalls).toHaveBeenCalledWith('authenticate', ['t3-code']);
  });
});
