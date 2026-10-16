import { NO_NETWORK } from '#core/catalog';
import { agentService } from '#core/services';

import {
  networkIdentityRecorder,
  readGuestEnvironment,
  writeGuestProfile,
} from './environment/store';

import type { NetworkWithDaemon } from '#core/networks';
import type { GuestChannel, GuestServiceState } from '#drivers/guest-channel';

/**
 * stops the managed network daemon while retaining enrolment and cleanup
 * identity, detaching the agent service that depended on it, and records the
 * workstation without a network; the setup plan that follows reinstalls the
 * agent service and drops the network's tool and daemon
 * @param guest exact target guest
 * @param network network driver whose daemon is being removed
 */
export async function disableNetwork(
  guest: GuestChannel,
  network: NetworkWithDaemon,
): Promise<void> {
  const environment = await readGuestEnvironment(guest);
  const { name: consumerName } = agentService(environment.profile);
  const services = await guest.services.list();
  const service = services.find((entry) => entry.name === network.daemon.name);
  const consumer = services.find((entry) => entry.name === consumerName);
  await detachConsumer(guest, {
    consumer: service ? consumer : undefined,
    daemon: network.daemon.name,
  });
  await network.release(guest, {
    service,
    recordIdentity: networkIdentityRecorder(guest, network.id),
  });
  await writeGuestProfile(guest, {
    ...environment.profile,
    network: NO_NETWORK,
    options: { ...environment.profile.options, isExitNodeEnabled: false },
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
