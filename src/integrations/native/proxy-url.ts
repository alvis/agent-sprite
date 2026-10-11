import { CommandFault } from '#errors';

/** documented native client endpoints derived from one CLIProxyAPI hub URL */
export interface ProxyEndpoints {
  claude: string;
  codex: string;
  models: string;
}

/**
 * derives Claude's hub root and Codex's versioned API base without duplicate prefixes
 * @param baseUrl hub URL, optionally ending in /v1
 * @returns native client bases and the non-billable model catalogue endpoint
 */
export function resolveProxyEndpoints(baseUrl: string): ProxyEndpoints {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (cause) {
    throw new CommandFault({
      code: 'INPUT',
      message: 'CLIProxyAPI base URL is not a valid URL',
      cause,
      causeVisibility: 'private',
    });
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new CommandFault({
      code: 'INPUT',
      message:
        'CLIProxyAPI base URL must use HTTP(S) without credentials, query, or fragment',
    });
  }
  const segments = url.pathname.split('/');
  url.pathname = segments
    .slice(0, segments.findLastIndex((segment) => segment.length > 0) + 1)
    .join('/')
    .replace(/\/v1$/, '');
  const claude = url.toString().replace(/\/$/, '');

  return { claude, codex: `${claude}/v1`, models: `${claude}/v1/models` };
}

/**
 * reports invalid direct proxy inputs without exposing their contents
 * @param baseUrl optional supplied hub URL
 * @returns aggregate-preflight diagnostics for a malformed hub URL
 */
export function proxyUrlProblems(baseUrl?: string): string[] {
  if (!baseUrl) {
    return [];
  }
  try {
    resolveProxyEndpoints(baseUrl);

    return [];
  } catch {
    return [
      'CLIProxyAPI base URL must use HTTP(S) without credentials, query, or fragment',
    ];
  }
}
