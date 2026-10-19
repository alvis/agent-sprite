import {
  resolveProxyEndpoints,
  proxyUrlProblems,
} from './cliproxyapi/endpoints';
import { CLIPROXYAPI_INPUTS } from './cliproxyapi/inputs';
import { preflightCliproxyapi } from './cliproxyapi/preflight';

import type { GatewayDriver } from '#application/ports/drivers';

/** CLIProxyAPI as a model-gateway driver */
export const cliproxyapi: GatewayDriver<'cliproxyapi'> = {
  id: 'cliproxyapi',
  kind: 'gateways',
  displayName: 'CLIProxyAPI',
  inputs: CLIPROXYAPI_INPUTS,
  endpoints: resolveProxyEndpoints,
  urlProblems: proxyUrlProblems,
  preflight: preflightCliproxyapi,
};
