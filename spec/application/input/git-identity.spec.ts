import { describe, expect, it, vi } from 'vitest';

import { resolveGitIdentity } from '#application/input/git-identity';
import { InteractionExit } from '#kernel/navigation';

import { dependencies } from '../../mocks/dependencies';

import type { Interaction } from '#application/ports/interaction';

const sources = { processEnv: {}, fileEnv: {}, profile: {} };
const identity = {
  authorName: 'Author',
  authorEmail: 'author@example.test',
  committerName: 'Committer',
  committerEmail: 'committer@example.test',
};

describe('fn:resolveGitIdentity', () => {
  it('should leave identity absent when local Git configuration is unavailable', async () => {
    const host = {
      ...dependencies.host,
      run: vi.fn<typeof dependencies.host.run>(async () => {
        throw new Error('Git config unavailable');
      }),
    } satisfies typeof dependencies.host;

    await expect(
      resolveGitIdentity(
        { host },
        { options: { nonInteractive: true }, sources },
      ),
    ).resolves.toBeUndefined();
  });

  it('should verify a supplied GitHub token before deriving the author identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json({
          login: 'account',
          name: 'Account',
          email: 'account@example.test',
        }),
      ),
    );

    await expect(
      resolveGitIdentity(dependencies, {
        options: { localCredentials: false },
        sources,
        githubToken: 'selected-token',
      }),
    ).resolves.toEqual({
      authorName: 'Account',
      authorEmail: 'account@example.test',
      committerName: 'Account',
      committerEmail: 'account@example.test',
    });
  });

  it('should collect missing author fields and keep independent committer values', async () => {
    const interaction = {
      input: async ({ message }) =>
        message.includes('email') ? 'entered@example.test' : 'Entered',
      select: async (_prompt, choices) =>
        choices.find(({ value }) => value === 'keep')!.value,
    } satisfies Partial<Interaction>;

    await expect(
      resolveGitIdentity(dependencies, {
        options: {
          localCredentials: false,
          gitCommitterName: identity.committerName,
          gitCommitterEmail: identity.committerEmail,
        },
        sources,
        interaction: interaction as Partial<Interaction> as Interaction,
      }),
    ).resolves.toEqual({
      ...identity,
      authorName: 'Entered',
      authorEmail: 'entered@example.test',
    });
  });

  it('should discard an abandoned edit and allow deliberately skipping the identity', async () => {
    const actions = ['edit', 'skip'];
    const interaction = {
      select: async (_prompt, choices) => {
        const action = actions.shift();

        return choices.find(({ value }) => value === action)!.value;
      },
      input: async () => {
        throw new InteractionExit('back');
      },
    } satisfies Partial<Interaction>;

    await expect(
      resolveGitIdentity(dependencies, {
        options: { localCredentials: false },
        sources,
        verifiedAccount: {
          login: 'author',
          name: identity.authorName,
          email: identity.authorEmail,
        },
        interaction: interaction as Partial<Interaction> as Interaction,
      }),
    ).resolves.toBeUndefined();
  });
});
