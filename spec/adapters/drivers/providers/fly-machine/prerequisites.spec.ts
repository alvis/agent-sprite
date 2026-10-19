import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { preflightFlyMachine } from '#adapters/drivers/providers/fly-machine/prerequisites';
import { tokenScopeProblem } from '#adapters/drivers/providers/fly-machine/token-scope';

import type { ProviderPreflightParams } from '#domain/prerequisites';

const NOW = new Date('2026-10-14T00:00:00Z');
const FUTURE = Math.floor(NOW.getTime() / 1_000) + 3_600;
const PAST = Math.floor(NOW.getTime() / 1_000) - 3_600;
const PERMISSION_LOCATION = 'https://api.fly.io/v1';
const DISCHARGE_LOCATION = 'https://api.fly.io/aaa/v1';
const SPRITES_TOKEN = 'alvis-tang/1234/0123abcd/4567cdef';

/**
 * renders a decoding as `fly tokens debug` prints it
 * @param caveats caveats of the permission macaroon
 * @returns printed JSON
 */
function decoding(caveats: Array<{ type: string; body: unknown }>): string {
  return JSON.stringify([
    { location: PERMISSION_LOCATION, caveats },
    {
      location: DISCHARGE_LOCATION,
      caveats: [
        { type: 'ValidityWindow', body: { not_before: 0, not_after: FUTURE } },
      ],
    },
  ]);
}

const ORGANIZATION_TOKEN = [
  { type: 'Organization', body: { id: 1, mask: 'rwcdC' } },
  { type: 'ValidityWindow', body: { not_before: 0, not_after: FUTURE } },
];

describe('fn:tokenScopeProblem', () => {
  it.each([
    ['an organization token', decoding(ORGANIZATION_TOKEN), undefined],
    [
      'a deploy token',
      decoding([
        ...ORGANIZATION_TOKEN,
        { type: 'Apps', body: { apps: { '42': 'rwcdC' } } },
      ]),
      'is narrowed by its Apps caveat, as deploy and SSH tokens are',
    ],
    [
      'a read-only organization token',
      decoding([{ type: 'Organization', body: { id: 1, mask: 'r' } }]),
      'lacks w, c, d access to its organization',
    ],
    [
      'an expired token',
      decoding([
        ...ORGANIZATION_TOKEN,
        { type: 'ValidityWindow', body: { not_before: 0, not_after: PAST } },
      ]),
      'has expired',
    ],
    [
      'text that is no decoding',
      'Error: not a token',
      'is not a Fly API token',
    ],
  ])('should judge %s', (_, printed, problem) => {
    expect(tokenScopeProblem(printed, NOW)).toBe(problem);
  });
});

/**
 * installs, for one test, a flyctl stand-in that prints a fixed version and
 * decoding, with its private configuration in the same temporary directory
 * @param printed what `fly tokens debug` prints
 * @returns preflight lookups resolving the stand-in
 */
async function standInFlyctl(
  printed: string,
): Promise<Pick<ProviderPreflightParams, 'findTool' | 'readVersion'>> {
  const directory = await mkdtemp(join(tmpdir(), 'open-agent-fly-preflight-'));
  onTestFinished(async () => rm(directory, { recursive: true, force: true }));
  vi.stubEnv('XDG_CONFIG_HOME', join(directory, 'config'));
  const program = join(directory, 'fly');
  const output = join(directory, 'decoding.json');
  await writeFile(output, printed);
  await writeFile(program, `#!/bin/sh\ncat '${output}'\n`);
  await chmod(program, 0o755);

  return {
    findTool: async (command) => (command === 'fly' ? program : undefined),
    readVersion: async () => 'fly v0.4.108 darwin/arm64',
  };
}

describe('fn:preflightFlyMachine', () => {
  it('should report a missing flyctl and a missing token together', async () => {
    const problems = await preflightFlyMachine(
      {
        findTool: async () => undefined,
        readVersion: async () => undefined,
      },
      NOW,
    );

    expect(problems.map(({ subject }) => subject)).toEqual([
      'fly',
      'FLY_API_TOKEN',
    ]);
  });

  it('should refuse a flyctl older than 0.4.108 without decoding the token', async () => {
    const tools = await standInFlyctl(decoding(ORGANIZATION_TOKEN));

    const problems = await preflightFlyMachine(
      {
        ...tools,
        readVersion: async () => 'fly v0.4.107 darwin/arm64',
        credential: 'FlyV1 fm2_org',
        credentialSource: 'FLY_API_TOKEN',
      },
      NOW,
    );

    expect(problems).toEqual([
      {
        subject: 'fly',
        problem: 'fly 0.4.107 is older than 0.4.108',
        fix: 'Install or upgrade flyctl: https://fly.io/docs/flyctl/install/',
      },
    ]);
  });

  it('should refuse a Sprites token by its shape without decoding it', async () => {
    const tools = await standInFlyctl('never read');

    const problems = await preflightFlyMachine(
      {
        ...tools,
        credential: SPRITES_TOKEN,
        credentialSource: 'FLY_API_TOKEN',
      },
      NOW,
    );

    expect(problems).toEqual([
      expect.objectContaining({
        subject: 'FLY_API_TOKEN',
        problem: expect.stringContaining('holds a Sprites API token'),
      }),
    ]);
  });

  it('should refuse a token flyctl decodes as narrower than an organization', async () => {
    const tools = await standInFlyctl(
      decoding([
        ...ORGANIZATION_TOKEN,
        { type: 'Apps', body: { apps: { '42': 'rwcdC' } } },
      ]),
    );

    const problems = await preflightFlyMachine(
      {
        ...tools,
        credential: 'FlyV1 fm2_deploy',
        credentialSource: 'FLY_API_TOKEN',
      },
      NOW,
    );

    expect(problems).toEqual([
      {
        subject: 'FLY_API_TOKEN',
        problem: expect.stringContaining(
          'FLY_API_TOKEN is narrowed by its Apps caveat',
        ),
        fix: expect.stringContaining('fly tokens create org'),
      },
    ]);
  });

  it('should accept an organization token', async () => {
    const tools = await standInFlyctl(decoding(ORGANIZATION_TOKEN));

    const problems = await preflightFlyMachine(
      {
        ...tools,
        credential: 'FlyV1 fm2_org',
        credentialSource: 'FLY_API_TOKEN',
      },
      NOW,
    );

    expect(problems).toEqual([]);
  });
});
