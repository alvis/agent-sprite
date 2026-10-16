import { finding, gatedFinding } from '#drivers/findings';

import type { ReadinessFinding } from '#drivers/contracts';
import type { NetworkReadinessContext } from '#drivers/networks/contracts';

import type { TailnetStatus } from './types';

/**
 * builds Tailscale checks, skipped for the routing the workstation does not select
 * @param status current native Tailscale status
 * @param context whether exit-node routing is selected
 * @returns connectivity and exit-route findings in reporting order
 */
export function tailscaleReadiness(
  status: TailnetStatus,
  context: NetworkReadinessContext,
): ReadinessFinding[] {
  const { isExitNodeEnabled: isRouted } = context;

  return [
    finding(status.online, 'Tailscale connectivity'),
    gatedFinding({
      isSelected: isRouted,
      passed: status.routeDevice === 'tailscale0',
      name: 'Tailscale exit route',
    }),
    gatedFinding({
      isSelected: isRouted,
      passed: status.dnsReady,
      name: 'Tailscale DNS',
    }),
    gatedFinding({
      isSelected: isRouted,
      passed: Boolean(status.egressIp),
      name: 'observed network egress',
    }),
  ];
}
