import { ensureError } from '#errors';
import { InteractionExit } from '#navigation/exit';
import { checkOperation } from '#operation';

import { sanitizeGuestDiagnostic } from './diagnostics.js';

import type {
  GuestInspection,
  InspectionProbeFailure,
} from './inspection-types.js';
import type { GuestIntegrations, GuestManifest } from './types.js';

type InspectionResults = readonly [
  PromiseSettledResult<GuestInspection['services']>,
  PromiseSettledResult<GuestInspection['tailscale']>,
  PromiseSettledResult<NonNullable<GuestInspection['native']>>,
  PromiseSettledResult<GuestInspection['hub']>,
];

const DIAGNOSTIC_LIMIT = 512;

/**
 * turns operational probe failures into current-state evidence without losing siblings
 * @param manifest current guest manifest
 * @param integrations selected integration state
 * @param results independently settled probe outcomes
 * @returns current inspection with explicit unavailable-probe evidence
 */
export function settleInspectionResults(
  manifest: GuestManifest,
  integrations: GuestIntegrations,
  results: InspectionResults,
): GuestInspection {
  checkOperation();
  const [serviceProbe, tailscaleProbe, nativeProbe, proxyProbe] = results;
  const probeFailures: InspectionProbeFailure[] = [];
  const services =
    inspectionValue(serviceProbe, 'services', probeFailures) ?? [];
  const tailscale = inspectionValue(
    tailscaleProbe,
    'tailscale',
    probeFailures,
  ) ?? {
    ...manifest.tailnetIdentity,
    online: false,
    dnsReady: false,
    skipped: false,
    reason: probeFailures.find((failure) => failure.probe === 'tailscale')
      ?.reason,
  };
  const native = inspectionValue(nativeProbe, 'native', probeFailures);
  const hub = inspectionValue(proxyProbe, 'proxy', probeFailures) ?? {
    reachable: false,
    skipped: false,
    reason: probeFailures.find((failure) => failure.probe === 'proxy')?.reason,
  };

  return {
    services,
    tailscale,
    native,
    hub,
    manifest,
    integrations,
    probeFailures,
  };
}

/**
 * keeps a failed operational probe as bounded evidence and rethrows code defects
 * @param result one settled live probe
 * @param probe probe identity
 * @param failures accumulating failures from this inspection
 * @returns the successful value or undefined for an unavailable probe
 */
function inspectionValue<T>(
  result: PromiseSettledResult<T>,
  probe: InspectionProbeFailure['probe'],
  failures: InspectionProbeFailure[],
): T | undefined {
  if (result.status === 'fulfilled') {
    return result.value;
  }
  const error = ensureError(result.reason);
  if (
    error instanceof InteractionExit ||
    error instanceof SyntaxError ||
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof RangeError
  ) {
    throw error;
  }
  failures.push({
    probe,
    reason:
      sanitizeGuestDiagnostic(error.message).slice(-DIAGNOSTIC_LIMIT) ||
      `${probe} probe unavailable`,
  });

  return undefined;
}
