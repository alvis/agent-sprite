import { describe, expect, it, vi } from 'vitest';

import { githubAccount } from '#application/input/github-account';

const token = 'selected-github-token';

describe('fn:githubAccount', () => {
  it('should return public account identity fields from a verified response', async () => {
    const account = {
      login: 'account',
      name: 'Account',
      email: 'account@example.test',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => Response.json(account)),
    );

    await expect(githubAccount(token)).resolves.toEqual(account);
  });

  it('should reject an HTTP authentication failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response('', { status: 401 })),
    );

    await expect(githubAccount(token)).rejects.toMatchObject({ code: 'AUTH' });
  });

  it.each([false, null, {}, { login: 7 }])(
    'should reject an invalid account response: %j',
    async (account) => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async () => Response.json(account)),
      );

      await expect(githubAccount(token)).rejects.toMatchObject({
        code: 'PROVIDER',
      });
    },
  );

  it.each([{ login: 'account' }, { login: 'account', name: null, email: 7 }])(
    'should leave unavailable public identity fields absent: %j',
    async (account) => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async () => Response.json(account)),
      );

      await expect(githubAccount(token)).resolves.toEqual({
        login: 'account',
        name: undefined,
        email: undefined,
      });
    },
  );
});
