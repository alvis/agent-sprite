import { NO_NETWORK } from '#domain/ids';
import { agentService } from '#domain/services';

import type { NetworkWithDaemon } from '#application/catalog/networks';
import type { GuestEnvironmentAccess } from '#application/ports/guest';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { ProductDeclarations } from '#domain/declarations';
import type { GuestServiceState } from '#domain/services';

/** declarations and environment access needed to disable a network */
interface DisableNetworkContext {
  declarations: ProductDeclarations;
  environment: GuestEnvironmentAccess;
}

/**
 * stops the managed network daemon while retaining enrolment and cleanup
 * identity, detaching the agent service that depended on it, and records the
 * workstation without a network; the setup plan that follows reinstalls the
 * agent service and drops the network's tool and daemon
 * @param context the data every registered driver declares and the recorded environment's access
 * @param context.declarations the data every registered driver declares
 * @param context.environment reads and writes of the recorded environment
 * @param guest exact target guest
 * @param network network driver whose daemon is being removed
 */
export async function disableNetwork(
  context: DisableNetworkContext,
  guest: GuestChannel,
  network: NetworkWithDaemon,
): Promise<void> {
  const { declarations, environment: access } = context;
  const environment = await access.read(guest);
  const { name: consumerName } = agentService(
    declarations,
    environment.profile,
  );
  const services = await guest.services.list();
  const service = services.find((entry) => entry.name === network.daemon.name);
  const consumer = services.find((entry) => entry.name === consumerName);
  await detachConsumer(guest, {
    consumer: service ? consumer : undefined,
    daemon: network.daemon.name,
  });
  await network.release(guest, {
    service,
    recordIdentity: access.identityRecorder(guest, network.id),
  });
  await access.writeProfile(guest, {
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
