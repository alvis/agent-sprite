import { isJsonObject } from '../serialization.js';

import type { JsonObject, JsonValue } from '../serialization.js';

const SERVICE_LABELS: Record<string, string> = {
  't3-code': 'T3 Code',
  'tailscaled': 'Tailscale',
  'agent-sprite-cron': 'Maintenance scheduler',
};

/**
 * prepares concise human inspection groups without altering structured results
 * @param data redacted command data
 * @returns readable detail groups
 */
export function humanResultDetails(data: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([key]) => key !== 't3Url')
      .map(([key, value]) => [
        key,
        key === 'inspection' || key === 'currentReadiness'
          ? inspectionDetails(value)
          : key === 'machine'
            ? machineDetails(
                value,
                data.inspection !== undefined ||
                  data.currentReadiness !== undefined,
              )
            : key === 'pairing'
              ? pairingDetails(value)
              : key === 'action' && value === 'copy'
                ? 'T3 URL copied to clipboard'
                : value,
      ]),
  );
}

/**
 * keeps pairing metadata in grouped output while copyable values are printed separately
 * @param value redacted pairing result
 * @returns non-secret pairing status and expiry
 */
function pairingDetails(value: JsonValue | undefined): JsonObject {
  const pairing = asRecord(value);

  return {
    status: pairing.status,
    expiresAt: pairing.expiresAt,
    reason: pairing.reason,
    retry: pairing.retry,
  };
}

/**
 * distinguishes pre-inspection provider observations from fresh guest checks
 * @param value workstation control-plane summary
 * @param inspected whether explicit live guest checks were performed
 * @returns machine identity and explicitly timed provider state
 */
function machineDetails(
  value: JsonValue | undefined,
  inspected: boolean,
): JsonObject {
  return Object.fromEntries(
    Object.entries(asRecord(value))
      .filter(([key]) => key !== 't3Url' && !(inspected && key === 'readiness'))
      .map(([key, nested]) => [
        inspected && key === 'state' ? 'Provider state before inspection' : key,
        nested,
      ]),
  );
}

/**
 * summarizes current checks rather than exposing process arguments and probe inventories
 * @param value explicit inspection or readiness result
 * @returns grouped service, integration, harness, and maintenance details
 */
function inspectionDetails(value: JsonValue | undefined): JsonObject {
  const inspection = asRecord(value);
  const native = asRecord(inspection.native);
  const manifest = asRecord(inspection.manifest);
  const discovery = asRecord(native.t3ProviderDiscovery);
  const readiness = asRecord(inspection.readiness);

  return {
    'ready': inspection.ready ?? readiness.ready,
    'failures': inspection.failures ?? readiness.failures,
    'skipped': inspection.skipped ?? readiness.skipped,
    'unavailable probes': inspection.probeFailures,
    'services': serviceDetails(inspection.services),
    'tailscale': inspection.tailscale,
    'cliproxyapi': inspection.hub,
    'Claude Code':
      native.claude === undefined
        ? undefined
        : {
            ...asRecord(native.claude),
            selectedPlugins: native.selectedClaudePlugins,
            loadedInT3: native.t3ClaudePluginLoading,
          },
    'Codex':
      native.codex === undefined
        ? undefined
        : {
            ...asRecord(native.codex),
            selectedPlugins: native.selectedCodexPlugins,
            loadedInT3: native.t3CodexPluginLoading,
          },
    'T3 providers':
      native.t3ProviderDiscovery === undefined
        ? undefined
        : providerDetails(discovery),
    'Installed tools':
      manifest.installedVersions === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(asRecord(manifest.installedVersions)).map(
              ([tool, version]) => [
                tool,
                typeof version === 'string' ? version.split('\n')[0] : version,
              ],
            ),
          ),
    'Maintenance':
      inspection.manifest === undefined
        ? undefined
        : {
            lastSuccessfulUpdate: manifest.lastSuccessfulUpdate,
            lastUpdateStatus: manifest.lastUpdateStatus,
          },
  };
}

/**
 * presents service state without execution arguments or process metadata
 * @param value current service list, when requested
 * @returns service names and observed states
 */
function serviceDetails(value: JsonValue | undefined): JsonObject | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return Object.fromEntries(
    value.map((item: JsonValue) => {
      const service = asRecord(item);
      const name =
        typeof service.name === 'string' ? service.name : 'Unknown service';

      return [
        SERVICE_LABELS[name] ?? name,
        typeof service.state === 'string'
          ? service.state
          : (asRecord(service.state).status ?? 'Not reported'),
      ];
    }),
  );
}

/**
 * summarizes T3 discovery and its limits while omitting the full skill inventory
 * @param discovery current provider discovery result
 * @returns provider identity and readiness groups
 */
function providerDetails(discovery: JsonObject): JsonObject {
  return {
    verified: discovery.ok,
    ...Object.fromEntries(
      (Array.isArray(discovery.providers) ? discovery.providers : []).map(
        (value: JsonValue | undefined) => {
          const provider = asRecord(value);
          const name =
            typeof provider.instanceId === 'string'
              ? provider.instanceId
              : 'Unknown provider';

          return [name, { driver: provider.driver, status: provider.status }];
        },
      ),
    ),
    reason: discovery.reason,
    limits: discovery.limits,
  };
}

/**
 * identifies a result group while allowing absent inspection sections
 * @param value result section to display
 * @returns present record or an empty group
 */
function asRecord(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {};
}
