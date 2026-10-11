import { checkOperation } from '#operation';
import { runLocal } from '#utilities/process';
import { rememberSecret } from '#utilities/redaction';

import type { CommandOptions } from '#command/contracts';

/**
 * discovers a GitHub token from the caller's local gh session
 * @param options parsed local credential policy and GitHub host
 * @returns the local token when available
 */
export async function discoverGithubToken(
  options: CommandOptions,
): Promise<string | undefined> {
  if (options.localCredentials === false) {
    return undefined;
  }

  const token = await runLocal({
    program: 'gh',
    arguments: [
      'auth',
      'token',
      '--hostname',
      options.githubHost ?? 'github.com',
    ],
  }).catch(() => {
    checkOperation();

    return undefined;
  });
  rememberSecret(token);

  return token;
}
