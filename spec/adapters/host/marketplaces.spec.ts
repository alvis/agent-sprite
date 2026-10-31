import { describe, expect, it, vi } from 'vitest';

import { classifyMarketplaceSource } from '#adapters/host/marketplaces';

import type { MarketplaceLookup } from '#application/ports/host';

const lookup = {
  source: 'owner/native.git',
  harness: 'claude',
  manifests: ['missing.json', 'native.json'],
} satisfies MarketplaceLookup;
const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
  const url = new Request(input).url;
  if (url.includes('/contents/missing.json')) {
    return new Response(null, { status: 404 });
  }

  return Response.json(
    url.includes('/contents/')
      ? {
          encoding: 'base64',
          content: Buffer.from(
            JSON.stringify({
              name: 'native-market',
              plugins: [{ name: 'helper', source: './helper' }],
            }),
          ).toString('base64'),
        }
      : { default_branch: 'main' },
  );
});

describe('fn:classifyMarketplaceSource', () => {
  it.each([
    {
      name: 'repository default',
      source: lookup.source,
      accessToken: undefined,
      ref: 'main',
    },
    {
      name: 'selected tree',
      source: 'https://github.com/owner/native/tree/feature/plugins',
      accessToken: 'generated-token',
      ref: 'feature%2Fplugins',
    },
  ])(
    'should classify a native marketplace at the $name ref after a missing candidate',
    async ({ source, accessToken, ref }) => {
      vi.stubGlobal('fetch', fetch);

      const result = await classifyMarketplaceSource({
        ...lookup,
        source,
        ...(accessToken ? { accessToken } : {}),
      });

      expect(result).toEqual({
        source,
        harness: 'claude',
        compatibility: 'supported',
        manifestPath: 'native.json',
        marketplaceName: 'native-market',
        pluginNames: ['helper'],
        reason: expect.stringContaining('Documented claude marketplace'),
      });
      const options = {
        headers: {
          Accept: 'application/vnd.github+json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        signal: expect.any(AbortSignal),
        redirect: 'error',
      };
      expect(fetch.mock.calls).toEqual([
        ['https://api.github.com/repos/owner/native', options],
        [
          `https://api.github.com/repos/owner/native/contents/missing.json?ref=${ref}`,
          options,
        ],
        [
          `https://api.github.com/repos/owner/native/contents/native.json?ref=${ref}`,
          options,
        ],
      ]);
    },
  );

  it.each([
    'invalid@owner/native',
    'owner/native/blob/main',
    'invalid@owner/native/tree/main',
  ])(
    'should leave an unsupported repository identity unknown: %s',
    async (source) => {
      vi.stubGlobal('fetch', fetch);

      expect(await classifyMarketplaceSource({ ...lookup, source })).toEqual({
        source,
        harness: 'claude',
        compatibility: 'unknown',
        reason: expect.stringContaining('not a GitHub repository'),
      });
      expect(fetch.mock.calls).toEqual([]);
    },
  );

  it('should report an inaccessible repository before looking for manifests', async () => {
    vi.stubGlobal('fetch', fetch);
    fetch.mockImplementationOnce(
      async () => new Response(null, { status: 403 }),
    );

    expect(await classifyMarketplaceSource(lookup)).toEqual({
      source: lookup.source,
      harness: 'claude',
      compatibility: 'inaccessible',
      reason: expect.stringContaining('403'),
    });
  });

  it.each([null, { default_branch: 42 }])(
    'should leave malformed repository metadata unknown: %j',
    async (metadata) => {
      vi.stubGlobal('fetch', fetch);
      fetch.mockImplementationOnce(async () => Response.json(metadata));

      expect(await classifyMarketplaceSource(lookup)).toEqual({
        source: lookup.source,
        harness: 'claude',
        compatibility: 'unknown',
        reason: expect.stringContaining('response was malformed'),
      });
    },
  );

  it.each([
    { status: 403, compatibility: 'inaccessible' },
    { status: 404, compatibility: 'unsupported' },
  ])(
    'should classify manifest lookup status $status as $compatibility',
    async ({ status, compatibility }) => {
      vi.stubGlobal('fetch', fetch);
      fetch.mockImplementation(async (input) =>
        new Request(input).url.includes('/contents/')
          ? new Response(null, { status })
          : Response.json({ default_branch: 'main' }),
      );

      expect(await classifyMarketplaceSource(lookup)).toEqual({
        source: lookup.source,
        harness: 'claude',
        compatibility,
        reason: expect.any(String),
      });
    },
  );

  it.each([
    { name: 'undecodable content', body: null, reason: 'could not be decoded' },
    {
      name: 'non-record manifest',
      body: {
        encoding: 'base64',
        content: Buffer.from('null').toString('base64'),
      },
      reason: 'native manifest structure',
    },
  ])(
    'should leave $name unknown rather than report compatibility',
    async ({ body, reason }) => {
      vi.stubGlobal('fetch', fetch);
      fetch.mockImplementation(async (input) =>
        Response.json(
          new Request(input).url.includes('/contents/')
            ? body
            : { default_branch: 'main' },
        ),
      );

      expect(await classifyMarketplaceSource(lookup)).toEqual({
        source: lookup.source,
        harness: 'claude',
        compatibility: 'unknown',
        manifestPath: 'missing.json',
        reason: expect.stringContaining(reason),
      });
    },
  );
});
