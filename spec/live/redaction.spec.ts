import { describe, expect, it } from 'vitest';

import { createRedactor } from './redaction';

describe('fn:createRedactor', () => {
  it('should replace every dotenv value by its variable name', () => {
    const redact = createRedactor({
      SPRITES_TOKEN: 'token-value',
      CLIPROXYAPI_BASE_URL: 'https://hub.example.test',
    });

    expect(
      redact('token-value at https://hub.example.test/v1 and token-value'),
    ).toBe(
      '[redacted:SPRITES_TOKEN] at [redacted:CLIPROXYAPI_BASE_URL]/v1 and [redacted:SPRITES_TOKEN]',
    );
  });

  it('should redact the longer value first when one value contains another', () => {
    const redact = createRedactor({
      TAILSCALE_TAILNET: 'tail-net',
      TAILSCALE_EXIT_NODE: 'tail-net-exit',
    });

    expect(redact('tail-net-exit.tail-net.ts.net')).toBe(
      '[redacted:TAILSCALE_EXIT_NODE].[redacted:TAILSCALE_TAILNET].ts.net',
    );
  });

  it('should redact the JSON-escaped form of a value', () => {
    const redact = createRedactor({ CLIPROXYAPI_API_KEY: 'key"with\\quote' });

    expect(redact(JSON.stringify({ key: 'key"with\\quote' }))).toBe(
      '{"key":"[redacted:CLIPROXYAPI_API_KEY]"}',
    );
  });

  it('should redact trimmed, URL-encoded and URL-host forms of a value', () => {
    const redact = createRedactor({
      CLIPROXYAPI_BASE_URL: ' https://hub.example.test:8317/ ',
      CLIPROXYAPI_API_KEY: 'key/with space',
    });

    expect(
      redact(
        'https://hub.example.test:8317/v1 hub.example.test:8317 key%2Fwith%20space',
      ),
    ).toBe(
      '[redacted:CLIPROXYAPI_BASE_URL]/v1 [redacted:CLIPROXYAPI_BASE_URL] [redacted:CLIPROXYAPI_API_KEY]',
    );
  });

  it('should keep control switches and values too short to redact safely', () => {
    const redact = createRedactor({
      TAILSCALE_ENABLED: 'true',
      NON_INTERACTIVE: 'false',
      CI: 'true',
      NO_COLOR: 'yes1',
      GIT_AUTHOR_NAME: 'abc',
      GH_TOKEN: '',
    });

    expect(redact('{"ok":true,"name":"abc","color":"yes1"}')).toBe(
      '{"ok":true,"name":"abc","color":"yes1"}',
    );
  });
});
