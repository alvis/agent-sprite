import { harnessDrivers, harnessIds } from '#core/harnesses';
import { serviceLabels } from '#core/services';

import { isJsonObject } from '../serialization.js';

import type { JsonObject, JsonValue } from '../serialization.js';

/** every C0 and C1 control character */
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/**
 * prepares concise human inspection groups without altering structured results
 * @param data redacted command data
 * @returns readable detail groups
 */
export function humanResultDetails(data: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([key]) => key !== 'agentUrl')
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
                ? 'Agent URL copied to clipboard'
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
      .filter(
        ([key]) => key !== 'agentUrl' && !(inspected && key === 'readiness'),
      )
      .map(([key, nested]) => [
        inspected && key === 'state' ? 'Provider state before inspection' : key,
        key === 'machine' ? machineSize(nested) : nested,
      ]),
  );
}

/**
 * words the machine size a provider reports
 * @param value provider-reported machine size
 * @returns the size name, CPUs and memory on one line, or the value as it is when malformed
 */
function machineSize(value: JsonValue | undefined): JsonValue | undefined {
  const { label, cpus, memoryGb } = asRecord(value);

  return typeof label === 'string' &&
    typeof cpus === 'number' &&
    typeof memoryGb === 'number'
    ? `${label}, ${String(cpus)} CPUs, ${String(memoryGb)} GB`
    : value;
}

/**
 * words the machine minimums a workstation recorded
 * @param options recorded profile options
 * @returns the minimums on one line, none when the profile records none
 */
function machineRequirement(options: JsonObject): string | undefined {
  const { minCpus, minMemoryGb } = options;

  return typeof minCpus === 'number' && typeof minMemoryGb === 'number'
    ? `at least ${String(minCpus)} CPUs, ${String(minMemoryGb)} GB`
    : undefined;
}

/**
 * summarizes current checks rather than exposing process arguments and probe inventories
 * @param value explicit inspection or readiness result
 * @returns grouped service, integration, harness, and maintenance details
 */
function inspectionDetails(value: JsonValue | undefined): JsonObject {
  const inspection = asRecord(value);
  const native = asRecord(inspection.native);
  const recorded = asRecord(inspection.environment);
  const updates = asRecord(inspection.updates);
  const environment = asRecord(native.agentEnvironment);
  const agentState = asRecord(native.harnesses);
  const readiness = asRecord(inspection.readiness);

  return {
    'ready': inspection.ready ?? readiness.ready,
    'failures': inspection.failures ?? readiness.failures,
    'skipped': inspection.skipped ?? readiness.skipped,
    'unavailable probes': inspection.probeFailures,
    'services': serviceDetails(inspection.services),
    'network': inspection.network,
    'cliproxyapi': inspection.hub,
    ...Object.fromEntries(
      harnessDrivers(harnessIds()).map((driver) => {
        const state = asRecord(agentState[driver.id]);

        return [
          driver.displayName,
          native[driver.id] === undefined
            ? undefined
            : {
                ...asRecord(native[driver.id]),
                selectedPlugins: state.selectedPlugins,
              },
        ];
      }),
    ),
    'Agent environment':
      native.agentEnvironment === undefined
        ? undefined
        : environmentDetails(environment),
    'Agent release channel': asRecord(asRecord(recorded.profile).options)
      .agentRelease,
    'Machine requirement': machineRequirement(
      asRecord(asRecord(recorded.profile).options),
    ),
    'Installed tools': installedTools(recorded.tools, updates.tools),
    'Skipped tools': skippedTools(asRecord(recorded.setup).skipped),
    'Last boot':
      inspection.boot === undefined
        ? undefined
        : bootDetails(asRecord(inspection.boot)),
    'Idle governor':
      inspection.governor === undefined
        ? undefined
        : governorLine(asRecord(inspection.governor)),
    'Maintenance':
      inspection.updates === undefined
        ? undefined
        : {
            lastSuccessfulUpdate: updates.lastSuccess,
            lastUpdateStartedAt: updates.startedAt,
            lastUpdateFinishedAt: updates.finishedAt,
            failedTools: failedTools(updates.tools),
          },
  };
}

/**
 * condenses the boot hook's record of the last boot: its result and start,
 * the steps that did not succeed, and the hook's latest log lines
 * @param boot the boot report from the inspection
 * @returns the last boot's details
 */
function bootDetails(boot: JsonObject): JsonObject {
  const unsuccessful = asRecord(boot.unsuccessfulSteps);

  return {
    status: boot.status ?? 'not recorded',
    startedAt: boot.startedAt,
    unsuccessfulSteps:
      Object.keys(unsuccessful).length === 0 ? undefined : unsuccessful,
    log: boot.log,
  };
}

/**
 * lists each installed tool with the version the last update left, or the
 * source setup installed it from when no update recorded one
 * @param tools the tools environment.json records
 * @param outcomes what the last update did to each tool
 * @returns the version or source by tool, none when nothing is recorded
 */
function installedTools(
  tools: JsonValue | undefined,
  outcomes: JsonValue | undefined,
): JsonObject | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }
  const versions = new Map(
    (Array.isArray(outcomes) ? outcomes : []).flatMap((entry) => {
      const { name, to } = asRecord(entry);

      return typeof name === 'string' && typeof to === 'string'
        ? [[name, to.split('\n')[0]] as const]
        : [];
    }),
  );

  return Object.fromEntries(
    tools.flatMap((entry) => {
      const { name, source } = asRecord(entry);

      return typeof name === 'string'
        ? [[name, versions.get(name) ?? asRecord(source).kind]]
        : [];
    }),
  );
}

/**
 * lists the optional tools setup skipped, with why
 * @param value the skipped tools environment.json records
 * @returns the reason by tool, none when none was skipped
 */
function skippedTools(value: JsonValue | undefined): JsonObject | undefined {
  const skipped = Array.isArray(value) ? value : [];

  return skipped.length === 0
    ? undefined
    : Object.fromEntries(
        skipped.flatMap((entry) => {
          const { name, reason } = asRecord(entry);

          return typeof name === 'string' ? [[name, reason]] : [];
        }),
      );
}

/**
 * names the tools the last update failed
 * @param value what the last update did to each tool
 * @returns the failed tools, none when none failed
 */
function failedTools(value: JsonValue | undefined): string[] | undefined {
  const failed = (Array.isArray(value) ? value : []).flatMap((entry) => {
    const { name, outcome } = asRecord(entry);

    return typeof name === 'string' && outcome === 'failed' ? [name] : [];
  });

  return failed.length === 0 ? undefined : failed;
}

/**
 * condenses the idle governor's recorded state into one line: the last
 * heartbeat, the open holds, then what the provider's keep-awake mode makes of
 * the awake deadline, then the last adapter failure or task release when there
 * is one. A `native-deadline` provider keeps the workstation awake until the
 * deadline and then follows its own idle rules, so sleep is never reported as
 * not permitted for it; a `governed` provider reports whether sleep is
 * permitted; a provider with no keep-awake mode is not governed. A deadline
 * already past is marked as passed. Every string the guest supplied is shown
 * without control characters, so a recorded value cannot move the cursor or
 * rewrite the terminal
 * @param report the governor report from the inspection
 * @returns the governor-state line
 */
function governorLine(report: JsonObject): string {
  if (report.recorded !== true) {
    return `not recorded (${typeof report.reason === 'string' ? printable(report.reason) : 'unavailable'})`;
  }
  const state = asRecord(report.state);
  const adapter = asRecord(state.adapter);
  const holds = typeof state.openHolds === 'number' ? state.openHolds : 0;

  return [
    typeof state.lastHeartbeat === 'string'
      ? `last heartbeat ${printable(state.lastHeartbeat)}`
      : 'no heartbeat yet',
    `${holds} open ${holds === 1 ? 'hold' : 'holds'}`,
    ...keepAwakeParts(state),
    ...(typeof adapter.failure === 'string'
      ? [`adapter failed: ${printable(adapter.failure)}`]
      : adapter.action === 'apply-deadline' && adapter.result === 'released'
        ? ['awake task released']
        : []),
  ].join('; ');
}

/**
 * words the awake deadline the way the provider's keep-awake mode treats it
 * @param state the recorded governor state
 * @returns the deadline and sleep parts of the governor line
 */
function keepAwakeParts(state: JsonObject): string[] {
  const deadline =
    typeof state.deadline === 'string' ? state.deadline : undefined;
  const isPassed = deadline !== undefined && Date.parse(deadline) <= Date.now();
  switch (state.keepAwakeMode) {
    case 'none':
      return ['not governed'];
    case 'native-deadline':
      return [
        deadline === undefined
          ? "nothing keeps it awake, the provider's idle rules apply"
          : isPassed
            ? `awake deadline ${printable(deadline)} passed, the provider's idle rules apply`
            : `awake until ${printable(deadline)}, then the provider's idle rules apply`,
      ];
    default:
      return [
        deadline === undefined
          ? 'nothing keeps it awake'
          : `awake until ${printable(deadline)}${isPassed ? ' (passed)' : ''}`,
        state.sleepPermitted === true
          ? 'sleep permitted'
          : 'sleep not permitted',
      ];
  }
}

/**
 * removes every C0 and C1 control character from guest-supplied text
 * @param text text read from the guest
 * @returns the text without control characters
 */
function printable(text: string): string {
  return text.replace(CONTROL_CHARACTERS, '');
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

  const labels = serviceLabels();

  return Object.fromEntries(
    value.map((item: JsonValue) => {
      const service = asRecord(item);
      const name =
        typeof service.name === 'string' ? service.name : 'Unknown service';

      return [
        labels[name] ?? name,
        typeof service.state === 'string'
          ? service.state
          : typeof service.status === 'string'
            ? service.status
            : 'Not reported',
      ];
    }),
  );
}

/**
 * summarizes what the running agent service reports at its environment endpoint
 * @param environment current environment inspection result
 * @returns whether the endpoint answered, with the server version, environment label and protocol version or the reason it did not
 */
function environmentDetails(environment: JsonObject): JsonObject {
  return {
    verified: environment.ok,
    serverVersion: environment.serverVersion,
    label: environment.label,
    orchestrationProtocolVersion: environment.orchestrationProtocolVersion,
    reason: environment.reason,
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
