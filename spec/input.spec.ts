import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  resolveCreateInputs,
  resolveInputs,
  resolveSpritesToken,
} from '#input';

describe('fn:resolveInputs', () => {
  it('should aggregate all missing integration inputs before account discovery', async () => {
    const input = await resolveInputs(
      {
        nonInteractive: true,
        localCredentials: false,
        github: false,
        gitIdentity: false,
      },
      undefined,
      {
        sources: { processEnv: {}, fileEnv: {}, profile: {} },
        required: [
          'name',
          'spritesToken',
          'tailscaleEnrollment',
          'tailnet',
          'exitNode',
          'proxyUrl',
          'proxyApiKey',
          'gitIdentity',
        ],
        integrations: { tailscale: true, exitNode: true, cliproxyapi: true },
      },
    );
    const defaults = await resolveInputs(
      {
        nonInteractive: true,
        localCredentials: false,
        github: false,
        gitIdentity: false,
      },
      undefined,
      {
        sources: { processEnv: {}, fileEnv: {}, profile: {} },
      },
    );

    expect([input.missing, defaults.missing]).toEqual([
      [
        expect.stringContaining('--name'),
        expect.stringContaining('SPRITES_TOKEN'),
        expect.stringContaining('TAILSCALE_API_KEY'),
        expect.stringContaining('TAILSCALE_TAILNET'),
        expect.stringContaining('TAILSCALE_EXIT_NODE'),
        expect.stringContaining('CLIPROXYAPI_BASE_URL'),
        expect.stringContaining('CLIPROXYAPI_API_KEY'),
      ],
      [
        expect.stringContaining('--name'),
        expect.stringContaining('SPRITES_TOKEN'),
      ],
    ]);
  });

  it('should report an invalid proxy URL without including embedded credentials', async () => {
    const input = await resolveInputs(
      {
        nonInteractive: true,
        localCredentials: false,
        github: false,
        gitIdentity: false,
        proxyUrl:
          'https://sensitive-user:sensitive-password@proxy.example.test',
      },
      undefined,
      {
        sources: { processEnv: {}, fileEnv: {}, profile: {} },
        required: ['proxyUrl'],
      },
    );

    expect(input.missing).toEqual([expect.stringContaining('CLIProxyAPI')]);
    expect(JSON.stringify(input.missing)).not.toMatch(
      /sensitive-user|sensitive-password/,
    );
  });

  it('should resolve independent author and committer identity without local credential discovery', async () => {
    const input = await resolveInputs(
      {
        nonInteractive: true,
        localCredentials: false,
        github: false,
        gitName: 'Flag Author',
        gitCommitterEmail: 'flag-committer@example.test',
      },
      undefined,
      {
        sources: {
          processEnv: {
            GIT_AUTHOR_NAME: 'Process Author',
            GIT_AUTHOR_EMAIL: 'process-author@example.test',
            GIT_COMMITTER_NAME: 'Process Committer',
          },
          fileEnv: {
            GIT_AUTHOR_EMAIL: 'file-author@example.test',
            GIT_COMMITTER_NAME: 'File Committer',
            GIT_COMMITTER_EMAIL: 'file-committer@example.test',
          },
          profile: {},
        },
        required: ['gitIdentity'],
      },
    );

    expect({ identity: input.gitIdentity, missing: input.missing }).toEqual({
      identity: {
        authorName: 'Flag Author',
        authorEmail: 'process-author@example.test',
        committerName: 'Process Committer',
        committerEmail: 'flag-committer@example.test',
      },
      missing: [],
    });
  });

  it('should include missing Git identity both before and after mandatory input resolution', async () => {
    vi.stubEnv('SPRITES_TOKEN', undefined);
    vi.stubEnv('GIT_AUTHOR_NAME', undefined);
    vi.stubEnv('GIT_AUTHOR_EMAIL', undefined);
    const directory = await mkdtemp(
      join(tmpdir(), 'agent-sprite-missing-identity-'),
    );
    vi.stubEnv('HOME', directory);
    const options = {
      nonInteractive: true,
      localCredentials: false,
      github: false,
    };

    try {
      const before = await resolveInputs(options, undefined, {
        sources: { processEnv: {}, fileEnv: {}, profile: {} },
        required: ['spritesToken', 'gitIdentity'],
      });
      const after = await resolveInputs(options, undefined, ['gitIdentity']);
      const known = await resolveInputs(
        { ...options, gitName: 'Known Author', gitEmail: 'known@example.test' },
        undefined,
        {
          sources: { processEnv: {}, fileEnv: {}, profile: {} },
          required: ['spritesToken', 'gitIdentity'],
        },
      );

      expect([before.missing, after.missing, known.missing]).toEqual([
        [
          expect.stringContaining('SPRITES_TOKEN'),
          expect.stringContaining('Git author'),
        ],
        [expect.stringContaining('Git author')],
        [expect.stringContaining('SPRITES_TOKEN')],
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should derive create preflight requirements from the selected integrations', async () => {
    for (const name of [
      'SPRITES_TOKEN',
      'TAILSCALE_API_KEY',
      'TAILSCALE_AUTH_KEY',
      'TAILSCALE_TAILNET',
      'TAILSCALE_EXIT_NODE',
      'CLIPROXYAPI_BASE_URL',
      'CLIPROXYAPI_API_KEY',
    ]) {
      vi.stubEnv(name, undefined);
    }
    const directory = await mkdtemp(
      join(tmpdir(), 'agent-sprite-create-input-'),
    );
    vi.stubEnv('HOME', directory);

    try {
      const selected = await resolveCreateInputs({
        tailscale: true,
        useExitNode: true,
        proxy: true,
        nonInteractive: true,
        localCredentials: false,
        github: false,
        gitIdentity: false,
      });

      expect({
        integrations: selected.integrations,
        missing: selected.missing,
      }).toEqual({
        integrations: { tailscale: true, exitNode: true, cliproxyapi: true },
        missing: [
          expect.stringContaining('--name'),
          expect.stringContaining('SPRITES_TOKEN'),
          expect.stringContaining('TAILSCALE_API_KEY'),
          expect.stringContaining('TAILSCALE_TAILNET'),
          expect.stringContaining('TAILSCALE_EXIT_NODE'),
          expect.stringContaining('CLIPROXYAPI_BASE_URL'),
          expect.stringContaining('CLIPROXYAPI_API_KEY'),
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should resolve a read-only provider token from the selected file or explicit reference', async () => {
    vi.stubEnv('SPRITES_TOKEN', undefined);
    const directory = await mkdtemp(
      join(tmpdir(), 'agent-sprite-provider-token-'),
    );
    vi.stubEnv('HOME', directory);
    const path = join(directory, 'chosen.env');
    const secretPath = join(directory, 'secret');
    await mkdir(join(directory, '.config', 'agent-sprite'), {
      recursive: true,
    });
    await writeFile(
      join(directory, '.config', 'agent-sprite', 'profile.json'),
      'malformed unrelated profile',
    );
    await writeFile(
      path,
      [
        'SPRITES_TOKEN=file-provider-secret',
        'GH_TOKEN=unused',
        'TAILSCALE_API_KEY=unused',
        '',
      ].join('\n'),
    );
    await writeFile(secretPath, 'explicit-provider-secret\n');

    try {
      const values = [
        await resolveSpritesToken({ env: path, localCredentials: false }),
        await resolveSpritesToken({
          env: path,
          spritesTokenSource: `file:${secretPath}`,
          localCredentials: false,
        }),
        await resolveSpritesToken({ localCredentials: false }),
      ];

      expect(values).toEqual([
        'file-provider-secret',
        'explicit-provider-secret',
        undefined,
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should report an unavailable required GitHub token and defer account lookup while mandatory inputs are missing', async () => {
    const options = { nonInteractive: true, localCredentials: false };
    const absent = await resolveInputs(options, undefined, {
      sources: { processEnv: {}, fileEnv: {}, profile: {} },
      required: ['githubToken'],
    });
    const deferred = await resolveInputs(options, undefined, {
      sources: {
        processEnv: { GH_TOKEN: 'unvalidated-account-candidate' },
        fileEnv: {},
        profile: {},
      },
      required: ['name', 'gitIdentity'],
    });

    expect([
      { token: absent.githubToken, missing: absent.missing },
      { token: deferred.githubToken, missing: deferred.missing },
    ]).toEqual([
      { token: undefined, missing: [expect.stringContaining('GitHub token')] },
      { token: undefined, missing: [expect.stringContaining('--name')] },
    ]);
  });
});
