import { describe, expect, it, vi } from 'vitest';

import { resolveInputs } from '#application/input';

import { dependencies, dependenciesWith } from '../../mocks/dependencies';

import type { HostPorts } from '#application/ports/host';

vi.mock(
  '#application/input/github-discovery',
  () =>
    ({
      discoverGithubToken: discovery,
    }) satisfies Partial<typeof import('#application/input/github-discovery')>,
);

const { discoverGithubToken: discovery } = vi.hoisted(
  () =>
    ({
      discoverGithubToken: vi.fn<
        typeof import('#application/input/github-discovery').discoverGithubToken
      >(async () => 'discovered-token'),
    }) satisfies Partial<typeof import('#application/input/github-discovery')>,
);

const fetchAccount = vi.fn<typeof fetch>(async () =>
  Response.json({ login: 'provided-user' }),
);
const fetchDiscoveredAccount = vi.fn<typeof fetch>(async () =>
  Response.json({ login: 'discovered-user' }),
);
const host = {
  ...dependencies.host,
  credentials: {
    ...dependencies.host.credentials,
    read: vi.fn<HostPorts['credentials']['read']>(async () => undefined),
  },
} satisfies HostPorts;

describe('fn:resolveInputs GitHub candidate routing', () => {
  it('should verify a supplied token without running local discovery', async () => {
    vi.stubGlobal('fetch', fetchAccount);

    const input = await resolveInputs(dependencies, {
      options: { nonInteractive: true, localCredentials: false },
      requirementSelection: {
        required: ['githubToken'],
        sources: {
          processEnv: { GH_TOKEN: 'provided-token' },
          fileEnv: {},
          profile: {},
        },
      },
    });

    expect({
      discovery: discovery.mock.calls,
      requests: fetchAccount.mock.calls,
      input: { githubToken: input.githubToken, missing: input.missing },
    }).toEqual({
      discovery: [],
      requests: [
        [
          'https://api.github.com/user',
          {
            headers: {
              Authorization: 'Bearer provided-token',
              Accept: 'application/vnd.github+json',
            },
            signal: expect.any(AbortSignal),
            redirect: 'error',
          },
        ],
      ],
      input: { githubToken: 'provided-token', missing: [] },
    });
  });

  it('should verify an explicitly discovered token when no source provides one', async () => {
    vi.stubGlobal('fetch', fetchDiscoveredAccount);

    const input = await resolveInputs(dependenciesWith({ host }), {
      options: { nonInteractive: true, localCredentials: true },
      requirementSelection: {
        required: [],
        discoverGithub: true,
        sources: { processEnv: {}, fileEnv: {}, profile: {} },
      },
    });

    expect({
      discovery: discovery.mock.calls,
      requests: fetchDiscoveredAccount.mock.calls,
      input: { githubToken: input.githubToken, missing: input.missing },
    }).toEqual({
      discovery: [
        [
          expect.anything(),
          expect.objectContaining({
            nonInteractive: true,
            localCredentials: true,
          }),
        ],
      ],
      requests: [
        [
          'https://api.github.com/user',
          {
            headers: {
              Authorization: 'Bearer discovered-token',
              Accept: 'application/vnd.github+json',
            },
            signal: expect.any(AbortSignal),
            redirect: 'error',
          },
        ],
      ],
      input: { githubToken: 'discovered-token', missing: [] },
    });
  });
});
