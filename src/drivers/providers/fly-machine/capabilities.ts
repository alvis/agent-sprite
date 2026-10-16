import { guestAsset } from '#integrations/guest/assets';
import { ROOT_ONLY_MODE } from '#os/contracts';

import { FLY_VARIABLES } from './boot-layout';
import { PRIVATE_V6_NETWORK, PROXY_V4_NETWORK } from './private-networks';

import type { ProviderCapabilities } from '#drivers/contracts';
import type { GuestAsset } from '#os/contracts';

/** the capability axes of a Fly Machine */
export const FLY_MACHINE_CAPABILITIES: ProviderCapabilities = {
  guestChannel: 'ssh',
  // the Fly proxy and the 6PN private network reach the machine over its
  // private interface; a tunnel's default route would otherwise capture their
  // replies and hang the guest channel and the public URL
  transportNetworks: [PROXY_V4_NETWORK, PRIVATE_V6_NETWORK],
  keepAwakeMode: 'governed',
  // a machine of at most 2 GB suspends from memory; any other is stopped
  idleForms: ['memory-suspend', 'stop'],
  wakeMode: 'url-traffic',
  supportsCliWakeSleep: false,
  // the idle governor alone decides, so no provider deadline limits it
  maxAwakeDeadlineMinutes: null,
  persistence: 'volume',
  exposure: 'provider-service',
  discovery: 'provider-metadata',
  // an update of the machine's guest reboots it
  resizeRestarts: true,
};

/**
 * the awake adapter the governor's tick runs to apply a deadline or enter an
 * idle form; root alone reaches the guest-local Machines API socket, so the
 * adapter runs as root and is root's alone
 */
export const FLY_MACHINE_AWAKE: GuestAsset = guestAsset(
  'drivers/providers/fly-machine/awake.sh',
  ROOT_ONLY_MODE,
  FLY_VARIABLES,
);
