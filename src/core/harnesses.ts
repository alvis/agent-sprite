import { recordHub } from '#drivers/shared/cliproxyapi/hub';
import { CommandFault } from '#errors';
import { AWAKE_COMMAND } from '#integrations/guest/awake';
import { recordOf } from '#utilities/records';
import { rememberSecret } from '#utilities/redaction';

import { catalog, DEFAULT_SELECTION } from './catalog';

import type { AwakeHookCommand, ProxyRoute } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

import type { HarnessId } from './catalog';

/** every registered harness driver */
type AnyHarnessDriver = (typeof catalog.harnesses)[HarnessId];

/** what each selected harness driver observed, keyed by harness identifier */
type HarnessInspections = {
  [Id in HarnessId]?: Awaited<
    ReturnType<(typeof catalog.harnesses)[Id]['inspect']>
  >;
};

/** the idle-governor command the work hooks of every harness invoke */
export const AWAKE_HOOK_COMMAND: AwakeHookCommand = {
  program: AWAKE_COMMAND,
};

/**
 * names a harness the way prompts and readiness checks address it
 * @param id harness identifier
 * @returns the identifier with its first letter capitalized
 */
export function harnessLabel(id: HarnessId): string {
  return `${id.slice(0, 1).toUpperCase()}${id.slice(1)}`;
}

/**
 * recognizes the identifier of a registered harness driver
 * @param value candidate identifier
 * @returns whether a harness driver is registered under it
 */
export function isHarnessId(value: string): value is HarnessId {
  return Object.hasOwn(catalog.harnesses, value);
}

/**
 * lists the identifiers of every registered harness driver
 * @returns harness identifiers in registration order
 */
export function harnessIds(): HarnessId[] {
  return Object.keys(catalog.harnesses).filter(isHarnessId);
}

/**
 * resolves harness drivers by identifier
 * @param ids selected harness identifiers; the default selection when omitted
 * @returns the selected drivers in the given order
 */
export function harnessDrivers(
  ids: readonly HarnessId[] = DEFAULT_SELECTION.harnesses,
): AnyHarnessDriver[] {
  return ids.map((id) => catalog.harnesses[id]);
}

/**
 * builds one value per registered harness, keyed by harness identifier
 * @param build derives the value from a harness driver
 * @returns the values keyed by harness identifier
 */
export function mapHarnesses<Value>(
  build: (driver: AnyHarnessDriver) => Value,
): Record<HarnessId, Value> {
  return recordOf(harnessIds(), (id) => build(catalog.harnesses[id]));
}

/**
 * observes the native state of every given harness concurrently
 * @param guest guest channel
 * @param drivers selected harness drivers
 * @returns each harness's inspection, keyed by harness identifier
 */
export async function inspectHarnesses(
  guest: GuestChannel,
  drivers: readonly AnyHarnessDriver[],
): Promise<HarnessInspections> {
  const entries = await Promise.all(
    drivers.map(
      async (driver) => [driver.id, await driver.inspect(guest)] as const,
    ),
  );

  return Object.fromEntries(entries);
}

/**
 * validates optional CLIProxyAPI inputs into the route harnesses are given
 * @param params whether routing is selected, the supplied hub inputs and the harnesses they apply to
 * @param params.enabled whether proxy-capable harnesses route through CLIProxyAPI
 * @param params.url hub base URL
 * @param params.apiKey hub client API key
 * @param params.drivers selected harness drivers
 * @returns the route, or undefined to restore native authentication; its key
 * is registered for redaction
 */
export function proxyRoute(params: {
  enabled: boolean;
  url?: string;
  apiKey?: string;
  drivers: readonly AnyHarnessDriver[];
}): ProxyRoute | undefined {
  const { enabled, url, apiKey, drivers } = params;
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

  return url && apiKey ? { url, apiKey } : undefined;
}

/**
 * records the gateway route, then merges native configuration and installs
 * work hooks for each selected harness in turn
 * @param guest guest channel
 * @param params selected harness drivers and the optional CLIProxyAPI route
 * @param params.drivers selected harness drivers
 * @param params.proxy CLIProxyAPI route, or undefined to restore native authentication
 */
export async function configureHarnesses(
  guest: GuestChannel,
  params: { drivers: readonly AnyHarnessDriver[]; proxy?: ProxyRoute },
): Promise<void> {
  await recordHub(guest, params.proxy);
  for (const driver of params.drivers) {
    await driver.configure(guest, {
      proxy: driver.supportsProxy ? params.proxy : undefined,
    });
    await driver.hooks.install(guest, AWAKE_HOOK_COMMAND);
  }
}
