import { harnessIds, harnessLabel } from '#domain/harnesses';
import { CommandFault } from '#kernel/faults';
import { recordOf } from '#kernel/records';
import { rememberSecret } from '#kernel/redaction';

import type {
  AwakeHookCommand,
  DriverRegistry,
  GatewayDriver,
  ProxyRoute,
} from '#application/ports/drivers';
import type { GuestMechanics } from '#application/ports/guest';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { HarnessId } from '#domain/ids';

/** every registered harness driver */
export type AnyHarnessDriver = DriverRegistry['harnesses'][HarnessId];

/** inputs for the optional harness proxy route */
interface ProxyRouteParams {
  enabled: boolean;
  gateway: GatewayDriver;
  drivers: readonly AnyHarnessDriver[];
  url?: string;
  apiKey?: string;
}

/** harnesses and guest facilities needed to configure them */
interface ConfigureHarnessesParams {
  drivers: readonly AnyHarnessDriver[];
  hub: GuestMechanics['hub'];
  awakeHook: AwakeHookCommand;
  proxy?: ProxyRoute;
}

/**
 * resolves harness drivers by identifier
 * @param registry every registered driver
 * @param ids selected harness identifiers
 * @returns the selected drivers in the given order
 */
export function harnessDrivers(
  registry: Pick<DriverRegistry, 'harnesses'>,
  ids: readonly HarnessId[],
): AnyHarnessDriver[] {
  return ids.map((id) => registry.harnesses[id]);
}

/**
 * builds one value per registered harness, keyed by harness identifier
 * @param registry every registered driver
 * @param build derives the value from a harness driver
 * @returns the values keyed by harness identifier
 */
export function mapHarnesses<Value>(
  registry: Pick<DriverRegistry, 'harnesses'>,
  build: (driver: AnyHarnessDriver) => Value,
): Record<HarnessId, Value> {
  return recordOf(harnessIds(), (id) => build(registry.harnesses[id]));
}

/**
 * validates optional CLIProxyAPI inputs into the route harnesses are given
 * @param params whether routing is selected, the gateway, the supplied hub inputs and the harnesses they apply to
 * @param params.enabled whether proxy-capable harnesses route through CLIProxyAPI
 * @param params.gateway the CLIProxyAPI driver that derives the hub endpoints
 * @param params.url hub base URL
 * @param params.apiKey hub client API key
 * @param params.drivers selected harness drivers
 * @returns the route, or undefined to restore native authentication; its key
 * is registered for redaction
 */
export function proxyRoute(params: ProxyRouteParams): ProxyRoute | undefined {
  const { enabled, gateway, url, apiKey, drivers } = params;
  if (!enabled) {
    return undefined;
  }
  const routed = drivers.find(({ supportsProxy }) => supportsProxy);
  if (routed && Boolean(url) !== Boolean(apiKey)) {
    throw new CommandFault({
      code: 'INPUT',
      message: `${harnessLabel(routed.id)} proxy URL and API key must be supplied together`,
    });
  }

  // registered, every file that embeds the key reaches the guest as a secret input
  rememberSecret(apiKey);

  return url && apiKey
    ? { endpoints: gateway.endpoints(url), apiKey }
    : undefined;
}

/**
 * records the gateway route, then merges native configuration and installs
 * work hooks for each selected harness in turn
 * @param guest guest channel
 * @param params selected harness drivers, the optional CLIProxyAPI route and what records and hooks it
 * @param params.drivers selected harness drivers
 * @param params.proxy CLIProxyAPI route, or undefined to restore native authentication
 * @param params.hub records the route on the guest
 * @param params.hub.record records the route on the guest
 * @param params.awakeHook the idle-governor command the work hooks invoke
 */
export async function configureHarnesses(
  guest: GuestChannel,
  params: ConfigureHarnessesParams,
): Promise<void> {
  await params.hub.record(guest, params.proxy);
  for (const driver of params.drivers) {
    await driver.configure(guest, {
      proxy: driver.supportsProxy ? params.proxy : undefined,
    });
    await driver.hooks.install(guest, params.awakeHook);
  }
}
