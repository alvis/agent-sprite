import { guestAsset } from '#guest/assets';
import { ROOT_ONLY_MODE } from '#os/contracts';

import { BOOT_HOOK } from './boot-layout.js';
import { FLY_MACHINE_AWAKE_MODULE } from './guest-modules.js';
import { PRIVATE_V6_NETWORK, PROXY_V4_NETWORK } from './private-networks.js';

import type { ProviderGuestLeaf } from '#drivers/contracts';

/** the guest facts of Fly Machines, readable without loading the driver */
export const flyMachineGuestLeaf: ProviderGuestLeaf = {
  // a Fly Machine adds no login account beside the agent account
  shellAccounts: [],
  capabilities: {
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
  },
  // a Fly Machine boots no init system, so runit supervises its services
  serviceBackend: 'runit',
  // a host move rebuilds the root filesystem from the image, which the boot
  // hook restores from the volume
  bootHook: BOOT_HOOK,
  // root alone reaches the guest-local Machines API socket, so the governor
  // imports the adapter as root and the agent account never can
  awakeAdapter: { module: FLY_MACHINE_AWAKE_MODULE, account: 'root' },
  // the governor's tick runs the adapter as root, so it is root's alone
  awakeAsset: guestAsset(
    'drivers/providers/fly-machine/guest/fly-machine-awake.sh',
    ROOT_ONLY_MODE,
  ),
};
