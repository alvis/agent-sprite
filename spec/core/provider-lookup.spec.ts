import { describe, expect, it, vi } from 'vitest';

import { providersHolding } from '#core/provider-lookup';
import { ProviderFault } from '#drivers/failures';

import type { BoundProvider } from '#core/provider-lookup';
import type { ProviderDriver } from '#drivers/contracts';

/**
 * binds a stand-in provider that answers get and list as given
 * @param id provider identifier
 * @param driver the parts of the driver the lookup calls
 * @returns the bound provider
 */
function bound(
  id: BoundProvider['id'],
  driver: Pick<ProviderDriver, 'get' | 'list'>,
): BoundProvider {
  return { id, driver: driver as ProviderDriver };
}

const notFound = new ProviderFault({ code: 'not-found', message: 'absent' });
const broken = new ProviderFault({ code: 'transient', message: 'down' });
const record = {} as Awaited<ReturnType<ProviderDriver['get']>>;

describe('fn:providersHolding', () => {
  it('should name the provider that holds a named workstation and ignore one that does not find it', async () => {
    const result = await providersHolding(
      [
        bound('sprite', {
          get: vi.fn(async () => Promise.reject(notFound)),
          list: vi.fn(async () => []),
        }),
        bound('fly-machine', {
          get: vi.fn(async () => record),
          list: vi.fn(async () => []),
        }),
      ],
      'mine',
    );

    expect(result).toEqual({ holders: ['fly-machine'], failures: [] });
  });

  it('should report a provider that could not be asked instead of counting it as empty', async () => {
    const result = await providersHolding(
      [
        bound('sprite', {
          get: vi.fn(async () => Promise.reject(broken)),
          list: vi.fn(async () => []),
        }),
      ],
      'mine',
    );

    expect(result).toEqual({ holders: [], failures: [broken] });
  });

  it('should name every provider that holds any workstation when no name is given', async () => {
    const result = await providersHolding([
      bound('sprite', {
        get: vi.fn(async () => record),
        list: vi.fn(async () => [record]),
      }),
      bound('fly-machine', {
        get: vi.fn(async () => record),
        list: vi.fn(async () => []),
      }),
    ]);

    expect(result).toEqual({ holders: ['sprite'], failures: [] });
  });
});
