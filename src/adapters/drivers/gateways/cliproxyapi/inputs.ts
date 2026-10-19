import type { GatewayInputs } from '#domain/declarations';

/** the caller-side inputs the CLIProxyAPI model gateway reads, declared once */
export const CLIPROXYAPI_INPUTS: GatewayInputs = {
  /** turns gateway routing on or off, like --proxy and --no-proxy */
  enabled: { environment: 'CLIPROXYAPI_ENABLED' },
  /** hub URL, non-secret and allowed in the saved input profile */
  baseUrl: {
    environment: 'CLIPROXYAPI_BASE_URL',
    prompt: 'CLIProxyAPI base URL',
    flag: '--proxy-url URL',
  },
  /** client key the guest uses to reach the hub */
  apiKey: {
    environment: 'CLIPROXYAPI_API_KEY',
    prompt: 'CLIProxyAPI client key',
    flag: '--proxy-api-key-source env:NAME, file:PATH, or keychain:SERVICE/ACCOUNT',
  },
};
