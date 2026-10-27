import { describe, expect, it } from 'vitest';

import { resolveGitIdentity } from '#application/input/git-identity';
import { selectGithubToken } from '#application/input/github';
import {
  readSetupSelection,
  resolveCreateSelection,
  resolveSetupSelection,
} from '#application/input/selection';
import { defaults } from '#composition/defaults';
import { defaultProfile } from '#domain/profile';

import { driveInk } from '../../fixtures/ink';
import { dependencies } from '../../mocks/dependencies';

describe('input source resolution', () => {
  it('should preserve the recorded and default selections under --yes without inventing features', async () => {
    const recorded = defaultProfile(defaults, 'tailscale');
    const sources = { processEnv: {}, fileEnv: {}, profile: {} };
    const observed = await driveInk(async (interaction) => {
      const setup = await resolveSetupSelection(dependencies, {
        options: { yes: true },
        sources,
        interaction,
        recorded,
        section: 'all',
        supplied: readSetupSelection(dependencies, {
          options: { yes: true },
          sources,
          section: 'all',
        }).value,
      });
      const create = await resolveCreateSelection(dependencies, {
        options: { yes: true },
        sources,
        interaction,
      });

      return { setup: setup.candidate, create: create.candidate };
    }, []);

    expect(observed.matchedSteps).toBe(0);
    expect(observed.result.setup).toMatchObject({
      network: 'tailscale',
      harnesses: recorded.harnesses,
    });
    expect(observed.result.create).toMatchObject({
      network: 'none',
      options: { isExitNodeEnabled: false, isProxyEnabled: false },
    });
  });

  it('should accept the default create selection through Enter at every prompt', async () => {
    const observed = await driveInk(
      async (interaction) =>
        resolveCreateSelection(dependencies, {
          options: {},
          sources: { processEnv: {}, fileEnv: {}, profile: {} },
          interaction,
        }),
      [
        { waitFor: 'Provider', input: '\r' },
        { waitFor: 'Minimum CPUs', input: '\r' },
        { waitFor: 'Minimum memory (GB)', input: '\r' },
        { waitFor: 'Release channel', input: '\r' },
        { waitFor: 'Harnesses', input: '\r' },
        { waitFor: 'Network', input: '\r' },
        { waitFor: 'Route harnesses through CLIProxyAPI?', input: '\r' },
        { waitFor: 'Suspend after idle', input: '\r' },
      ],
    );

    expect(observed.matchedSteps, observed.output).toBe(8);
    expect(observed.result.candidate).toMatchObject({
      provider: 'sprite',
      harnesses: ['claude', 'codex'],
      network: 'none',
      options: {
        minCpus: 2,
        minMemoryGb: 2,
        agentRelease: 'stable',
        isProxyEnabled: false,
        idleTimeoutMinutes: 5,
      },
    });
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
        const edited = await resolveGitIdentity(dependencies, {
          ...context,
          interaction,
        });
        const skipped = await resolveGitIdentity(dependencies, {
          ...context,
          interaction,
        });

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
    const result = await resolveGitIdentity(dependencies, {
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
