import { each, projectFields, same } from './fields';

import type { ReadinessAssessment } from '#application/readiness';
import type { InspectionProbeFailure } from '#domain/observations/inspection';

/** an inspection that could not run */
export interface ProbeFailureOutput {
  probe: string;
  reason: string;
}

/** whether a workstation is ready, with the checks that failed or were skipped */
export interface ReadinessOutput {
  ready: boolean;
  failures: readonly string[];
  skipped: readonly string[];
  probeFailures: ProbeFailureOutput[];
}

/**
 * projects an inspection that could not run
 * @param failure internal probe failure
 * @returns output probe failure
 */
export function projectProbeFailure(
  failure: InspectionProbeFailure,
): ProbeFailureOutput {
  return projectFields<InspectionProbeFailure, ProbeFailureOutput>(failure, {
    probe: same,
    reason: same,
  });
}

/**
 * projects a readiness assessment
 * @param readiness internal assessment
 * @returns output assessment
 */
export function projectReadiness(
  readiness: ReadinessAssessment,
): ReadinessOutput {
  return projectFields<ReadinessAssessment, ReadinessOutput>(readiness, {
    ready: same,
    failures: same,
    skipped: same,
    probeFailures: each(projectProbeFailure),
  });
}
