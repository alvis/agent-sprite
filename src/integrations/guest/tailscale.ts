import { InteractionExit } from '#navigation/exit';
import { checkOperation, runOperation, runBoundedIO } from '#operation';

import { isRecord } from '#utilities/guards';

import { runGuest, runGuestResult } from '../guest.js';

import {
  ensureTailnetDaemon,
  enrollTailnet,
  restoreTailnetDns,
} from './daemon.js';
import { sanitizeGuestDiagnostic } from './diagnostics.js';
import {
  guestIntegrations,
  readGuestManifest,
  writeGuestIntegrations,
  writeGuestTailnetIdentity,
} from './manifest.js';
import { readGuestServiceRegistry } from './service-registry.js';
import { installManagedServices } from './services.js';
import { openServiceStream, consumeServiceStream } from './stream.js';
import { parseTailnetStatus } from './tailscale-status.js';
import { guestServiceRequest, withGuestTransaction } from './transaction.js';

import type { Sprite } from '@fly/sprites';

import type { TailnetExitNode } from '#integrations/tailscale';

import type { GuestServiceRegistration } from './service-registry.js';

import type { TailnetStatus } from './types.js';

const TAILSCALE_SERVICE = 'tailscaled';
const NETWORK_PROBE_TIMEOUT_MS = 10_000;
const EGRESS_PROBE_TIMEOUT_MS = 15_000;
const DIAGNOSTIC_LIMIT = 512;

export type { TailnetStatus } from './types.js';

/**
 * starts the persistent Tailscale daemon and enrols through a transient key file
 * @param sprite target guest
 * @param authKey single-use enrolment key when the guest is not registered
 * @param exitNode selected exit node or native selector
 */
export async function configureTailscale(
  sprite: Sprite,
  authKey: string | undefined,
  exitNode?: TailnetExitNode | string,
): Promise<void> {
  await withGuestTransaction(sprite, async () => {
    await ensureTailnetDaemon(sprite);
    await selectTailnetExitNode(sprite, authKey, exitNode);
    const status = await inspectTailscale(sprite);
    assertTailnetReady(status, exitNode);
    await writeGuestTailnetIdentity(sprite, {
      deviceId: status.deviceId,
      ip: status.ip,
    });
  });
}

/**
 * stops the managed Tailscale daemon while retaining enrolment and cleanup identity
 * @param sprite target guest
 */
export async function disableTailscale(sprite: Sprite): Promise<void> {
  await withGuestTransaction(sprite, async () => {
    const manifest = await readGuestManifest(sprite);
    const services = await readGuestServiceRegistry(sprite);
    const service = services.find((entry) => entry.name === TAILSCALE_SERVICE);
    const consumer = services.find((entry) => entry.name === 't3-code');
    await detachTailnetConsumer(sprite, service ? consumer : undefined);
    if (service?.state?.status === 'running') {
      const status = await inspectTailscale(sprite);
      await writeGuestTailnetIdentity(sprite, {
        deviceId: status.deviceId,
        ip: status.ip,
      });
      const stream = await openServiceStream(async () =>
        guestServiceRequest(sprite, async () =>
          sprite.stopService(TAILSCALE_SERVICE, '15s'),
        ),
      );
      const failures: string[] = [];
      await consumeServiceStream(stream, (event) => {
        if (event.type === 'error') {
          failures.push(event.type);
        }
      });
      if (failures.length > 0) {
        throw new Error('Tailscale service reported a stop failure');
      }
    }
    if (service) {
      await runBoundedIO(async () =>
        guestServiceRequest(sprite, async () =>
          sprite.deleteService(TAILSCALE_SERVICE),
        ),
      );
    }
    await restoreTailnetDns(sprite);
    const integrations = guestIntegrations(manifest);
    await writeGuestIntegrations(sprite, {
      ...integrations,
      tailscale: false,
      exitNode: false,
    });
    if (consumer) {
      await installManagedServices(sprite);
    }
  });
}

/**
 * enrols a new guest or updates the current native exit-node selection
 * @param sprite target guest
 * @param authKey single-use enrolment key for a new device
 * @param exitNode selected exit node or native selector
 */
async function selectTailnetExitNode(
  sprite: Sprite,
  authKey: string | undefined,
  exitNode?: TailnetExitNode | string,
): Promise<void> {
  const selected =
    typeof exitNode === 'string' ? exitNode : (exitNode?.ip ?? '');
  const current = await runGuestResult(sprite, [
    '/opt/agent-sprite/tools/tailscale',
    'status',
    '--json',
  ]);
  const status: unknown =
    current.exitCode === 0 ? JSON.parse(current.stdout) : undefined;
  const enrolled =
    isRecord(status) && isRecord(status.Self) && Boolean(status.Self.ID);
  if (enrolled) {
    await runGuest(sprite, [
      '/opt/agent-sprite/tools/tailscale',
      'set',
      '--accept-dns=false',
    ]);
    await runGuest(sprite, [
      '/opt/agent-sprite/tools/tailscale',
      'set',
      `--exit-node=${selected}`,
      '--exit-node-allow-lan-access=false',
      '--accept-dns=true',
    ]);

    return;
  }
  if (!authKey) {
    throw new Error(
      'A Tailscale enrolment key is required for this unregistered device',
    );
  }
  await enrollTailnet(sprite, authKey, selected);
}

/**
 * requires live route, DNS, and egress evidence for the selected exit node
 * @param status current native Tailscale status
 * @param exitNode requested exit node
 */
function assertTailnetReady(
  status: TailnetStatus,
  exitNode?: TailnetExitNode | string,
): void {
  if (!status.online) {
    throw new Error('Tailscale did not confirm current tailnet connectivity');
  }
  if (!exitNode) {
    return;
  }
  if (
    !status.exitNode ||
    status.routeDevice !== 'tailscale0' ||
    !status.dnsReady ||
    !status.egressIp
  ) {
    throw new Error(
      'Tailscale did not confirm current exit route, DNS, and egress readiness',
    );
  }
  const selectedIp =
    typeof exitNode === 'string'
      ? /^[0-9.]+$/.test(exitNode)
        ? exitNode
        : undefined
      : exitNode.ip;
  if (selectedIp && status.exitNodeIp !== selectedIp) {
    throw new Error('Tailscale selected a different exit node than requested');
  }
}

/**
 * inspects the current Tailscale client without using cached status
 * @param sprite target guest
 * @returns current tailnet identity, route, DNS, and egress status
 */
export async function inspectTailscale(sprite: Sprite): Promise<TailnetStatus> {
  let result: Awaited<ReturnType<typeof runGuestResult>>;
  try {
    result = await runGuestResult(sprite, [
      '/opt/agent-sprite/tools/tailscale',
      'status',
      '--json',
    ]);
  } catch (error) {
    checkOperation();
    if (
      error instanceof InteractionExit ||
      error instanceof SyntaxError ||
      error instanceof TypeError ||
      error instanceof ReferenceError ||
      error instanceof RangeError
    ) {
      throw error;
    }

    return offlineTailnetStatus(
      error instanceof Error ? error.message : 'Tailscale status unavailable',
    );
  }
  if (result.exitCode !== 0) {
    return offlineTailnetStatus(
      `Tailscale status exited with status ${result.exitCode}: ${result.stderr}`,
    );
  }
  const status: unknown = JSON.parse(result.stdout);
  if (!isRecord(status)) {
    throw new Error('Tailscale returned a malformed status result');
  }

  const hasExitNode = isRecord(status.ExitNodeStatus);

  return parseTailnetStatus(
    status,
    hasExitNode ? await probeTailnetEgress(sprite) : { dnsReady: false },
  );
}

/**
 * records a failed live status probe without implying a disabled integration
 * @param reason bounded guest or transport diagnostic
 * @returns offline, unskipped tailnet status
 */
function offlineTailnetStatus(reason: string): TailnetStatus {
  return {
    online: false,
    dnsReady: false,
    skipped: false,
    reason:
      sanitizeGuestDiagnostic(reason).slice(-DIAGNOSTIC_LIMIT) ||
      'Tailscale status unavailable',
  };
}

/**
 * checks DNS, the routed device, and public egress without accepting proxies
 * @param sprite target guest
 * @returns current network probe evidence
 */
async function probeTailnetEgress(
  sprite: Sprite,
): Promise<Pick<TailnetStatus, 'routeDevice' | 'dnsReady' | 'egressIp'>> {
  const [dns, egress] = await runOperation(async () =>
    Promise.allSettled([
      runGuest(sprite, ['/usr/bin/getent', 'ahostsv4', 'api.ipify.org'], {
        timeoutMs: NETWORK_PROBE_TIMEOUT_MS,
      }),
      runGuest(
        sprite,
        [
          '/usr/bin/env',
          '-u',
          'HTTPS_PROXY',
          '-u',
          'HTTP_PROXY',
          '-u',
          'ALL_PROXY',
          '/usr/bin/curl',
          '-4',
          '--fail',
          '--silent',
          '--show-error',
          '--max-time',
          '10',
          'https://api.ipify.org',
        ],
        { timeoutMs: EGRESS_PROBE_TIMEOUT_MS },
      ),
    ]),
  );
  const probeAddress =
    dns.status === 'fulfilled'
      ? dns.value.stdout.trim().split(/\s+/)[0]
      : undefined;
  const route = probeAddress
    ? await runGuest(
        sprite,
        ['/usr/sbin/ip', '-4', 'route', 'get', probeAddress],
        {
          timeoutMs: NETWORK_PROBE_TIMEOUT_MS,
        },
      ).catch(() => {
        checkOperation();

        return undefined;
      })
    : undefined;
  const egressIp =
    egress.status === 'fulfilled' ? egress.value.stdout.trim() : undefined;

  return {
    routeDevice: /\bdev\s+(\S+)/.exec(route?.stdout ?? '')?.[1],
    dnsReady: dns.status === 'fulfilled' && dns.value.stdout.trim().length > 0,
    egressIp: egressIp && /^[0-9.]+$/.test(egressIp) ? egressIp : undefined,
  };
}

/**
 * detaches the managed T3 consumer before removing its tailnet dependency
 * @param sprite exact target guest
 * @param t3 existing T3 service, if registered
 */
async function detachTailnetConsumer(
  sprite: Sprite,
  t3: GuestServiceRegistration | undefined,
): Promise<void> {
  if (t3?.state?.status === 'running') {
    const stream = await openServiceStream(async () =>
      guestServiceRequest(sprite, async () =>
        sprite.stopService('t3-code', '15s'),
      ),
    );
    await consumeServiceStream(stream, (event) => {
      if (event.type === 'error') {
        throw new Error('T3 service reported a stop failure');
      }
    });
  }
  if (t3?.needs.includes(TAILSCALE_SERVICE)) {
    await runBoundedIO(async () =>
      guestServiceRequest(sprite, async () => sprite.deleteService('t3-code')),
    );
  }
}
