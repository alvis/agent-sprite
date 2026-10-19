import { finding } from '#domain/findings';

import { t3Service } from './service';

import type {
  AgentReadiness,
  AgentReadinessEvidence,
} from '#application/ports/drivers';

import type { T3Environment } from '#domain/observations/agent';

/**
 * derives T3 service and environment endpoint findings from gathered evidence
 * @param evidence services and the environment the running T3 service reports
 * @returns grouped findings in the order the workstation reports them
 */
export function t3Readiness(
  evidence: AgentReadinessEvidence<T3Environment>,
): AgentReadiness {
  const { services, environment } = evidence;
  const service = services.find(({ name }) => name === t3Service.name);

  return {
    service: [finding(service?.status === 'running', 'T3 service')],
    environment: [finding(environment?.ok === true, 'T3 environment endpoint')],
  };
}
