import { describe, expect, it } from 'vitest';

import { preflightCliproxyapi } from '#adapters/drivers/gateways/cliproxyapi/preflight';

describe('fn:preflightCliproxyapi', () => {
  it('should name every source of each absent gateway credential', () => {
    const problems = preflightCliproxyapi({});

    expect(problems).toEqual([
      {
        subject: 'CLIPROXYAPI_BASE_URL',
        problem: 'CLIProxyAPI base URL is not set',
        fix:
          'Set CLIPROXYAPI_BASE_URL or pass --credential-file FILE containing CLIPROXYAPI_BASE_URL; ' +
          'use --proxy-url URL; or run in a TTY to enter it when prompted.',
      },
      {
        subject: 'CLIPROXYAPI_API_KEY',
        problem: 'CLIProxyAPI client key is not set',
        fix:
          'Set CLIPROXYAPI_API_KEY or pass --credential-file FILE containing CLIPROXYAPI_API_KEY; ' +
          'use --proxy-api-key-source env:NAME, file:PATH, or keychain:SERVICE/ACCOUNT; ' +
          'or run in a TTY to enter it when prompted.',
      },
    ]);
  });

  it('should report nothing once both gateway credentials are resolved', () => {
    expect(
      preflightCliproxyapi({
        url: 'https://proxy.example.test',
        apiKey: 'client-key',
      }),
    ).toEqual([]);
  });
});
