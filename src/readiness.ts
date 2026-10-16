import { catalog } from '#core/catalog';
import { harnessDrivers } from '#core/harnesses';
import { networkDriver } from '#core/networks';
import { finding, gatedFinding } from '#drivers/findings';
import { cronService } from '#services/cron';

import { CommandFault } from './errors';

import type { ReadinessFinding } from '#drivers/contracts';
import type {
  GuestInspection,
  InspectionProbeFailure,
} from '#integrations/guest/inspection-types';

/** specific current-state failures from a guest readiness inspection */
export interface ReadinessAssessment {
  ready: boolean;
  failures: string[];
  skipped: string[];
  probeFailures: InspectionProbeFailure[];
}

/** failed readiness retains the observed checks rather than just their prose */
export class ReadinessFault extends CommandFault {
  public readonly readiness: ReadinessAssessment;

  /**
   * records failed checks before public exposure
   * @param readiness current readiness observations
   */
  constructor(readiness: ReadinessAssessment) {
    super({
      code: 'PREFLIGHT',
      message: `Current readiness failed (${readiness.failures.join(', ')}); public exposure was withheld`,
    });
    this.readiness = readiness;
  }
}

/**
 * evaluates current routing, service, gateway, and native harness evidence
 * @param inspection fresh guest inspection, including native plugin loading
 * @returns readiness and named checks that could not be verified
 */
export function assessReadiness(
  inspection: GuestInspection,
): ReadinessAssessment {
  const findings = readinessChecks(inspection);
  const failures = findings
    .filter(({ status }) => status === 'failed')
    .map(({ name }) => name);
  failures.push(
    ...inspection.probeFailures.map(
      ({ probe }) => `${probe} inspection unavailable`,
    ),
  );

  return {
    ready: failures.length === 0,
    failures,
    skipped: findings
      .filter(({ status }) => status === 'skipped')
      .map(({ name }) => name),
    probeFailures: inspection.probeFailures,
  };
}

/**
 * builds required service, environment, and enabled-integration checks,
 * interleaving the agent, network, gateway and harness findings in reporting order
 * @param inspection fresh guest inspection
 * @returns named readiness findings in reporting order
 */
function readinessChecks(inspection: GuestInspection): ReadinessFinding[] {
  const { profile } = inspection.environment;
  const { native } = inspection;
  const { isExitNodeEnabled, isProxyEnabled } = profile.options;
  const drivers = harnessDrivers(profile.harnesses);
  const agent = catalog.agents[profile.agent].readiness({
    services: inspection.services,
    environment: native?.agentEnvironment,
  });
  const network = networkDriver(profile.network);

  return [
    ...agent.service,
    finding(
      inspection.services.some(
        (service) =>
          service.name === cronService.name && service.status === 'running',
      ),
      'maintenance cron service',
    ),
    ...agent.environment,
    ...network.readiness(inspection.network, { isExitNodeEnabled }),
    gatedFinding({
      isSelected: isProxyEnabled,
      passed: inspection.hub.reachable,
      name: 'CLIProxyAPI gateway',
    }),
    ...drivers.flatMap((driver) =>
      driver.readiness(native?.[driver.id], {
        proxy: isProxyEnabled,
      }),
    ),
  ];
}
