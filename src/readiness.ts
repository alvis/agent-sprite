import { CommandFault } from './errors.js';

import type {
  GuestInspection,
  InspectionProbeFailure,
} from '#integrations/guest/runtime';

/** specific current-state failures from a guest readiness inspection */
export interface ReadinessAssessment {
  ready: boolean;
  failures: string[];
  skipped: string[];
  probeFailures: InspectionProbeFailure[];
}

type ReadinessCheck = readonly [passed: boolean, name: string];

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
  const failures = readinessChecks(inspection)
    .filter(([passed]) => !passed)
    .map(([, name]) => name);
  failures.push(
    ...inspection.probeFailures.map(
      ({ probe }) => `${probe} inspection unavailable`,
    ),
  );

  return {
    ready: failures.length === 0,
    failures,
    skipped: skippedReadinessChecks(inspection),
    probeFailures: inspection.probeFailures,
  };
}

/**
 * builds required service, plugin, provider, and enabled-integration checks
 * @param inspection fresh guest inspection
 * @returns named readiness predicates
 */
function readinessChecks(inspection: GuestInspection): ReadinessCheck[] {
  return [
    ...coreReadinessChecks(inspection),
    ...integrationReadinessChecks(inspection),
  ];
}

/**
 * builds readiness checks that apply to every workstation
 * @param inspection fresh guest inspection
 * @returns service and native loading checks
 */
function coreReadinessChecks(inspection: GuestInspection): ReadinessCheck[] {
  const t3 = inspection.services.find((service) => service.name === 't3-code');
  const discovery = inspection.native?.t3ProviderDiscovery;

  return [
    [t3?.state?.status === 'running', 'T3 service'],
    [
      inspection.services.some(
        (service) =>
          service.name === 'agent-sprite-cron' &&
          service.state?.status === 'running',
      ),
      'maintenance cron service',
    ],
    [discovery?.ok === true, 'fresh T3 provider discovery'],
    [
      inspection.native?.t3ClaudePluginLoading === 'verified',
      'selected Claude plugin visibility in T3',
    ],
    [
      inspection.native?.t3CodexPluginLoading === 'verified',
      'selected Codex plugin visibility in T3',
    ],
  ];
}

/**
 * builds checks only for integrations selected in the guest manifest
 * @param inspection fresh guest inspection
 * @returns enabled Tailscale and proxy checks
 */
function integrationReadinessChecks(
  inspection: GuestInspection,
): ReadinessCheck[] {
  const claudeReady = isProviderReady(inspection, 'claudeAgent');
  const codexReady = isProviderReady(inspection, 'codex');

  return [
    ...(inspection.integrations.tailscale
      ? ([
          [inspection.tailscale.online, 'Tailscale connectivity'],
          ...(inspection.integrations.exitNode
            ? ([
                [
                  inspection.tailscale.routeDevice === 'tailscale0',
                  'Tailscale exit route',
                ],
                [inspection.tailscale.dnsReady, 'Tailscale DNS'],
                [
                  Boolean(inspection.tailscale.egressIp),
                  'observed network egress',
                ],
              ] as ReadinessCheck[])
            : []),
        ] as ReadinessCheck[])
      : []),
    ...(inspection.integrations.cliproxyapi
      ? ([
          [inspection.hub.reachable, 'CLIProxyAPI gateway'],
          [claudeReady, 'Claude provider ready in T3'],
          [codexReady, 'Codex provider ready in T3'],
          [
            inspection.native?.claude.gatewayConfigured === true,
            'Claude gateway configuration',
          ],
          [
            inspection.native?.claude.modelDiscoveryEnabled === true,
            'Claude model discovery',
          ],
          [
            inspection.native?.codex.gatewayConfigured === true,
            'Codex gateway configuration',
          ],
          [
            inspection.native?.codex.modelDiscoveryEnabled === true,
            'Codex model discovery',
          ],
        ] as ReadinessCheck[])
      : []),
  ];
}

/**
 * detects one installed and authenticated provider in fresh T3 discovery
 * @param inspection fresh guest inspection
 * @param driver native T3 provider driver
 * @returns whether the provider reported ready
 */
function isProviderReady(
  inspection: GuestInspection,
  driver: 'claudeAgent' | 'codex',
): boolean {
  return (inspection.native?.t3ProviderDiscovery?.providers ?? []).some(
    (provider) =>
      provider.driver === driver &&
      provider.enabled &&
      provider.installed &&
      provider.status === 'ready',
  );
}

/**
 * names integration checks intentionally omitted by persisted selections
 * @param inspection fresh guest inspection
 * @returns explicitly skipped check names
 */
function skippedReadinessChecks(inspection: GuestInspection): string[] {
  return [
    ...(!inspection.integrations.tailscale
      ? [
          'Tailscale connectivity',
          'Tailscale exit route',
          'Tailscale DNS',
          'observed network egress',
        ]
      : !inspection.integrations.exitNode
        ? ['Tailscale exit route', 'Tailscale DNS', 'observed network egress']
        : []),
    ...(!inspection.integrations.cliproxyapi
      ? [
          'CLIProxyAPI gateway',
          'Claude provider ready in T3',
          'Codex provider ready in T3',
          'Claude gateway configuration',
          'Claude model discovery',
          'Codex gateway configuration',
          'Codex model discovery',
        ]
      : []),
  ];
}
