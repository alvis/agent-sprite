import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { resolveGitIdentity, selectGithubToken } from '#input/github';
import {
  resolveCreateIntegrations,
  resolveSetupIntegrations,
} from '#input/integrations';

import { driveInk } from '../fixtures/ink.js';

describe('workflow:input source resolution', () => {
  it('should preserve existing and disabled integration choices under --yes without inventing features', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-sprite-yes-choices-'));
    for (const name of [
      'TAILSCALE_ENABLED',
      'TAILSCALE_EXIT_NODE_ENABLED',
      'CLIPROXYAPI_ENABLED',
    ]) {
      vi.stubEnv(name, undefined);
    }
    vi.stubEnv('HOME', home);
    try {
      const observed = await driveInk(async (interaction) => {
        const installed = await resolveSetupIntegrations({
          options: { yes: true, localCredentials: false },
          interaction,
          installed: { tailscale: true, exitNode: true, cliproxyapi: true },
          selectedSection: 'all',
        });
        const create = await resolveCreateIntegrations(
          { yes: true, localCredentials: false },
          interaction,
        );
        const explicit = await resolveCreateIntegrations(
          {
            yes: true,
            tailscale: true,
            useExitNode: true,
            proxy: true,
            localCredentials: false,
          },
          interaction,
        );

        return {
          installed,
          create: create.integrations,
          explicit: explicit.integrations,
        };
      }, []);

      expect(observed.matchedSteps).toBe(0);
      expect(observed.result).toEqual({
        installed: { tailscale: true, exitNode: true, cliproxyapi: true },
        create: { tailscale: false, exitNode: false, cliproxyapi: false },
        explicit: { tailscale: true, exitNode: true, cliproxyapi: true },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('should accept installed setup choices and disabled create defaults through five Enter prompts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-sprite-input-'));
    vi.stubEnv('HOME', home);
    try {
      const observed = await driveInk(
        async (interaction) => {
          const setup = await resolveSetupIntegrations({
            options: { localCredentials: false },
            interaction,
            installed: { tailscale: true, exitNode: true, cliproxyapi: true },
            selectedSection: 'all',
          });
          const create = await resolveCreateIntegrations(
            { localCredentials: false },
            interaction,
          );

          return { setup, create: create.integrations };
        },
        [
          { waitFor: 'Enable Tailscale?', input: '\r' },
          { waitFor: 'Route through a Tailscale exit node?', input: '\r' },
          { waitFor: 'Enable CLIProxyAPI?', input: '\r' },
          { waitFor: 'Enable Tailscale?', input: '\r' },
          { waitFor: 'Enable CLIProxyAPI?', input: '\r' },
        ],
      );

      expect(observed.matchedSteps, observed.output).toBe(5);
      expect(observed.result).toEqual({
        setup: { tailscale: true, exitNode: true, cliproxyapi: true },
        create: { tailscale: false, exitNode: false, cliproxyapi: false },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('should edit prefilled Git fields, navigates to a previous field, then skips identity', async () => {
    const context = {
      options: {
        localCredentials: false,
        gitName: 'Ada',
        gitEmail: 'ada@example.test',
      },
      sources: { processEnv: {}, fileEnv: {}, profile: {} },
    };
    const observed = await driveInk(
      async (interaction) => {
        const edited = await resolveGitIdentity({ ...context, interaction });
        const skipped = await resolveGitIdentity({ ...context, interaction });

        return { edited, skipped: skipped === undefined };
      },
      [
        { waitFor: 'Git commit identity', input: 'Edit author' },
        { waitFor: 'Search: Edit author', input: '\r' },
        { waitFor: 'Git author name:', input: ' Lovelace' },
        { waitFor: 'Ada Lovelace', input: '\r' },
        { waitFor: 'Git author email:', input: '\x1b' },
        { waitFor: 'Git author name:', input: '\r' },
        { waitFor: 'Git author email:', input: '\r' },
        { waitFor: 'Git committer name:', input: '\r' },
        { waitFor: 'Git committer email:', input: '\r' },
        { waitFor: 'Git commit identity', input: '\r' },
        { waitFor: 'Git commit identity', input: 'Skip Git' },
        { waitFor: 'Search: Skip Git', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(12);
    expect(observed.result.edited).toMatchObject({
      authorName: 'Ada Lovelace',
    });
    expect(observed.result.skipped).toBe(true);
  });

  it('should mask GitHub replacement through back, failed retry and skip', async () => {
    const replacement = 'unverifiable-replacement';
    const observed = await driveInk(
      async (interaction) =>
        selectGithubToken(
          undefined,
          { githubHost: 'invalid/path' },
          interaction,
        ),
      [
        { waitFor: 'GitHub credential: add or skip?', input: '\r' },
        { waitFor: 'GitHub token:', input: '\x1b' },
        { waitFor: 'GitHub credential: add or skip?', input: '\r' },
        { waitFor: 'GitHub token:', input: [replacement, '\r'] },
        { waitFor: 'GitHub credential: add or skip?', input: 'Skip GitHub' },
        { waitFor: 'Search: Skip GitHub', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(6);
    expect(observed.result).toBeUndefined();
    expect(observed.output).not.toContain(replacement);
  });

  it('should use explicit Git identity fields without local discovery', async () => {
    const result = await resolveGitIdentity({
      options: {
        localCredentials: false,
        nonInteractive: true,
        gitName: 'Ada',
        gitEmail: 'ada@example.test',
      },
      sources: { processEnv: {}, fileEnv: {}, profile: {} },
    });

    expect(result).toEqual({
      authorName: 'Ada',
      authorEmail: 'ada@example.test',
      committerName: 'Ada',
      committerEmail: 'ada@example.test',
    });
  });

  it('should reject an invalid GitHub host before attempting credential verification', async () => {
    await expect(
      selectGithubToken('test-token', { githubHost: 'invalid/path' }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'INPUT',
        message: expect.stringContaining('GitHub host must be a hostname'),
      }),
    );
  });
});
