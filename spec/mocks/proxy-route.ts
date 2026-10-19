import { resolveProxyEndpoints } from '#adapters/drivers/gateways/cliproxyapi/endpoints';

import type { ProxyRoute } from '#application/ports/drivers';

/**
 * builds the route the application resolves for a gateway URL
 * @param url hub URL, optionally ending in /v1
 * @param apiKey client key the hub accepts
 * @returns the route with its endpoints resolved
 */
export function routeOf(url: string, apiKey: string): ProxyRoute {
  return { endpoints: resolveProxyEndpoints(url), apiKey };
}
