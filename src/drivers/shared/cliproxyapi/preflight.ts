import { missingInput } from '#drivers/shared/prerequisites';

import { CLIPROXYAPI_INPUTS } from './inputs';

import type {
  InputPrerequisite,
  PrerequisiteProblem,
} from '#drivers/providers/prerequisites';

/** the gateway credentials a run resolved, absent when no source holds them */
interface GatewayPreflightParams {
  /** hub URL */
  url?: string;
  /** hub client key */
  apiKey?: string;
}

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
