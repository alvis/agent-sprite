import { CommandFault } from '#errors';

/** documented native client endpoints derived from one CLIProxyAPI hub URL */
interface ProxyEndpoints {
  /** hub root, without a version prefix */
  root: string;
  /** hub root with the versioned API prefix */
  versioned: string;
  /** non-billable model catalogue endpoint */
  models: string;
}

/**
 * derives the hub root and the versioned API base without duplicate prefixes
 * @param baseUrl hub URL, optionally ending in /v1
 * @returns client bases and the non-billable model catalogue endpoint
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
  const root = url.toString().replace(/\/$/, '');

  return { root, versioned: `${root}/v1`, models: `${root}/v1/models` };
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
