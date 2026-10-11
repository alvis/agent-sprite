import { CommandFault, providerErrorCode } from '#errors';
import { operationSignal, runOperation } from '#operation';

const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

/**
 * validates a selected GitHub token and fetch only account identity fields
 * @param token candidate GitHub credential
 * @param hostname selected native GitHub hostname
 * @returns login, name, and email provided by the account endpoint
 */
export async function githubAccount(
  token: string,
  hostname = 'github.com',
): Promise<{ login: string; name?: string; email?: string }> {
  const host = new URL(`https://${hostname}`);
  if (
    host.host !== hostname.toLowerCase() ||
    host.pathname !== '/' ||
    host.username ||
    host.password ||
    host.search ||
    host.hash
  ) {
    throw new CommandFault({
      code: 'INPUT',
      message: 'GitHub host must be a hostname without credentials or paths',
    });
  }
  const endpoint =
    hostname.toLowerCase() === 'github.com'
      ? 'https://api.github.com/user'
      : `https://${host.host}/api/v3/user`;
  const response = await runOperation(async () =>
    fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
      signal: operationSignal(GITHUB_REQUEST_TIMEOUT_MS),
      redirect: 'error',
    }),
  );
  if (!response.ok) {
    throw new CommandFault({
      code: providerErrorCode(response.status),
      message: `GitHub credential rejected (${response.status})`,
    });
  }
  const user: unknown = await runOperation(async () => response.json());
  if (
    typeof user !== 'object' ||
    user === null ||
    !('login' in user) ||
    typeof user.login !== 'string'
  ) {
    throw new CommandFault({
      code: 'PROVIDER',
      message: 'Invalid GitHub account response',
    });
  }

  return {
    login: user.login,
    name:
      'name' in user && typeof user.name === 'string' ? user.name : undefined,
    email:
      'email' in user && typeof user.email === 'string'
        ? user.email
        : undefined,
  };
}
