import type { HarnessReadinessContext } from '#application/ports/drivers';
import type { NativeHarnessInspection } from '#domain/observations/harness';
import type { ReadinessFinding, ReadinessStatus } from '#domain/readiness';

/**
 * reports gateway routing checks of a proxy-capable harness
 * @param label harness name used in the check names
 * @param inspection native configuration evidence, absent when inspection failed
 * @param context facts the checks depend on
 * @returns gateway and model-discovery findings, skipped when no proxy is selected
 */
export function proxyReadiness(
  label: string,
  inspection: NativeHarnessInspection | undefined,
  context: HarnessReadinessContext,
): ReadinessFinding[] {
  const outcome = (passed: boolean): ReadinessStatus => {
    if (!context.proxy) {
      return 'skipped';
    }

    return passed ? 'passed' : 'failed';
  };

  return [
    {
      name: `${label} gateway configuration`,
      status: outcome(inspection?.gatewayConfigured === true),
    },
    {
      name: `${label} model discovery`,
      status: outcome(inspection?.modelDiscoveryEnabled === true),
    },
  ];
}

/**
 * reports whether the harness's hooks carry the idle governor's awake
 * commands, which no proxy choice makes optional: without them the harness
 * never reports activity, so the workstation could sleep mid-turn
 * @param label harness name used in the check name
 * @param inspection native configuration evidence, absent when inspection failed
 * @returns the awake-hooks finding
 */
export function awakeHooksReadiness(
  label: string,
  inspection: NativeHarnessInspection | undefined,
): ReadinessFinding {
  return {
    name: `${label} awake hooks`,
    status: inspection?.awakeHooksInstalled === true ? 'passed' : 'failed',
  };
}
