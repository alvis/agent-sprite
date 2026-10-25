import { harnessDrivers } from '#application/catalog/harnesses';
import { networkDriver } from '#application/catalog/networks';
import { finding, gatedFinding } from '#domain/findings';
import { CRON_SERVICE_NAME } from '#domain/services';

import { CommandFault } from '#kernel/faults';

import type { ApplicationDependencies } from '#application/ports/dependencies';
import type {
  GuestInspection,
  InspectionProbeFailure,
} from '#domain/observations/inspection';
import type { ReadinessFinding } from '#domain/readiness';

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
 * @param dependencies the registered drivers
 * @param inspection fresh guest inspection, including native plugin loading
 * @returns readiness and named checks that could not be verified
 */
export function assessReadiness(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  inspection: GuestInspection,
): ReadinessAssessment {
  const findings = readinessChecks(dependencies, inspection);
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
 * names the mismatch between the version the agent's running server reports
 * and the version its CLI's manager reported installed, which a restart that
 * left an earlier server running shows; an agent whose server reports no
 * version, or a CLI with no recorded version, is not compared
 * @param dependencies the registered drivers
 * @param inspection fresh guest inspection, made once the agent was started
 * @returns the failure naming both versions, or nothing when they agree or either is unknown
 */
export function servedVersionMismatch(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  inspection: GuestInspection,
): string | undefined {
  const { displayName, tools } =
    dependencies.registry.agents[inspection.environment.profile.agent];
  const served = inspection.native?.agentEnvironment;
  const installed = inspection.environment.tools.find(
    ({ name }) => name === tools[0]?.name,
  )?.version;
  if (!served?.ok || installed === undefined) {
    return undefined;
  }

  return served.serverVersion === installed
    ? undefined
    : `${displayName} serves ${served.serverVersion} but ${installed} is installed`;
}

/**
 * builds required service, environment, and enabled-integration checks,
 * interleaving the agent, network, gateway and harness findings in reporting order
 * @param dependencies the registered drivers
 * @param inspection fresh guest inspection
 * @returns named readiness findings in reporting order
 */
function readinessChecks(
  dependencies: Pick<ApplicationDependencies, 'registry'>,
  inspection: GuestInspection,
): ReadinessFinding[] {
  const { profile } = inspection.environment;
  const { native } = inspection;
  const { isExitNodeEnabled, isProxyEnabled } = profile.options;
  const drivers = harnessDrivers(dependencies.registry, profile.harnesses);
  const agent = dependencies.registry.agents[profile.agent].readiness({
    services: inspection.services,
    environment: native?.agentEnvironment,
  });
  const network = networkDriver(dependencies.registry, profile.network);

  return [
    ...agent.service,
    finding(
      inspection.services.some(
        (service) =>
          service.name === CRON_SERVICE_NAME && service.status === 'running',
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
