import { NO_NETWORK } from '#core/catalog';
import { agentService } from '#core/services';

import { writeComponentCatalog } from './component-catalog.js';
import {
  readGuestManifest,
  networkIdentityRecorder,
  writeGuestProfile,
} from './manifest.js';
import { installManagedServices } from './services.js';
import { withGuestTransaction } from './transaction.js';

import type { NetworkWithDaemon } from '#core/networks';
import type { GuestChannel, GuestServiceState } from '#drivers/guest-channel';

/**
 * stops the managed network daemon while retaining enrolment and cleanup
 * identity, drops the network from the updater's catalog, then reinstalls the
 * services that depended on it
 * @param guest exact target guest
 * @param network network driver whose daemon is being removed
 */
export async function disableNetwork(
  guest: GuestChannel,
  network: NetworkWithDaemon,
): Promise<void> {
  await withGuestTransaction(guest, async () => {
    const manifest = await readGuestManifest(guest);
    const { name: consumerName } = agentService(manifest.profile);
    const services = await guest.services.list();
    const service = services.find(
      (entry) => entry.name === network.daemon.name,
    );
    const consumer = services.find((entry) => entry.name === consumerName);
    await detachConsumer(guest, {
      consumer: service ? consumer : undefined,
      daemon: network.daemon.name,
    });
    await network.release(guest, {
      service,
      recordIdentity: networkIdentityRecorder(guest, network.id),
    });
    const profile = {
      ...manifest.profile,
      network: NO_NETWORK,
      options: { ...manifest.profile.options, isExitNodeEnabled: false },
    };
    await writeGuestProfile(guest, profile);
    // the updater reads the catalog, so it must stop updating the deselected
    // network even when no agent service was registered to reinstall
    await writeComponentCatalog(guest, profile);
    if (consumer) {
      await installManagedServices(guest);
    }
  });
}

/** the agent service that depends on a daemon, and the daemon's name */
interface ConsumerDetachment {
  /** existing agent service, if registered and the daemon is */
  consumer: GuestServiceState | undefined;
  /** name of the daemon about to be removed */
  daemon: string;
}

/**
 * detaches the managed agent service before removing its network dependency
 * @param guest exact target guest
 * @param detachment existing agent service and the daemon it may depend on
 */
async function detachConsumer(
  guest: GuestChannel,
  detachment: ConsumerDetachment,
): Promise<void> {
  const { consumer, daemon } = detachment;
  if (
    consumer?.status === 'running' &&
    !(await guest.services.stop(consumer.name))
  ) {
    throw new Error('The agent service reported a stop failure');
  }
  if (consumer?.needs.includes(daemon)) {
    await guest.services.remove(consumer.name);
  }
}
