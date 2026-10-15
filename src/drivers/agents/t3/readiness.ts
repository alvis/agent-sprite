import { finding } from '#drivers/findings';

import { t3Service } from './service.js';

import type {
  AgentReadiness,
  AgentReadinessEvidence,
} from '#drivers/contracts';

import type { T3Environment } from './evidence.js';

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
