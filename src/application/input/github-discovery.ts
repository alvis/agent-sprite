import { checkOperation } from '#kernel/operation';
import { rememberSecret } from '#kernel/redaction';

import type { CommandOptions } from '#application/contracts';
import type { ApplicationDependencies } from '#application/ports/dependencies';

/**
 * discovers a GitHub token from the caller's local gh session
 * @param dependencies what this computer provides
 * @param options parsed local credential policy and GitHub host
 * @returns the local token when available
 */
export async function discoverGithubToken(
  dependencies: Pick<ApplicationDependencies, 'host'>,
  options: CommandOptions,
): Promise<string | undefined> {
  if (options.localCredentials === false) {
    return undefined;
  }

  const token = await dependencies.host
    .run({
      program: 'gh',
      arguments: [
        'auth',
        'token',
        '--hostname',
        options.githubHost ?? 'github.com',
      ],
    })
    .catch(() => {
      checkOperation();

      return undefined;
    });
  rememberSecret(token);

  return token;
}
