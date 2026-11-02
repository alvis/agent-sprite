import { describe, expect, it, vi } from 'vitest';

import { resolveProviderCredential } from '#application/input/provider-credential';

import { dependencies } from '../../mocks/dependencies';

describe('fn:resolveProviderCredential', () => {
  it('should label a provider credential selected from the local store', async () => {
    const read = vi.fn<typeof dependencies.host.credentials.read>(
      async () => 'stored-token',
    );
    const host = {
      ...dependencies.host,
      credentials: { ...dependencies.host.credentials, read },
    } satisfies typeof dependencies.host;

    await expect(
      resolveProviderCredential(
        { ...dependencies, host },
        {
          options: {},
          provider: 'sprite',
          selection: { sources: { processEnv: {}, fileEnv: {} } },
        },
      ),
    ).resolves.toEqual({
      token: 'stored-token',
      source: expect.stringContaining('sprites'),
    });
    expect(read.mock.calls).toEqual([['sprites', undefined]]);
  });
});
