import { missingInput } from '#domain/prerequisites';

import { CLIPROXYAPI_INPUTS } from './inputs';

import type { GatewayPreflightParams } from '#application/ports/drivers';
import type {
  InputPrerequisite,
  PrerequisiteProblem,
} from '#domain/prerequisites';

/**
 * checks, offline, that every credential a harness routed through the gateway
 * needs is present
 * @param params the resolved hub URL and client key
 * @returns one problem per absent credential, each with its fix
 */
export function preflightCliproxyapi(
  params: GatewayPreflightParams,
): PrerequisiteProblem[] {
  const declared: Array<[InputPrerequisite, string | undefined]> = [
    [CLIPROXYAPI_INPUTS.baseUrl, params.url],
    [CLIPROXYAPI_INPUTS.apiKey, params.apiKey],
  ];

  return declared.flatMap(([input, value]) =>
    value ? [] : [missingInput(input)],
  );
}
