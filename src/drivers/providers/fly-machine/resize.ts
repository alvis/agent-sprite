import { ProviderFault } from '#drivers/failures';

import { FLY_MACHINES, guestOf } from './machines.js';

import type { MachineOffer } from '#drivers/contracts';

import type { FlyApi } from './api.js';
import type { FlyMachine } from './wire.js';

/** one machine and the size it moves to */
interface ResizeParams {
  /** authenticated Machines API client */
  api: FlyApi;
  /** app name, which is the workstation name */
  app: string;
  /** the machine as observed before the resize */
  machine: FlyMachine;
  /** machine size to run on */
  offer: MachineOffer;
}

/**
 * moves a machine to a size by changing only its guest, which restarts it; a
 * machine already on the size is not touched
 * @param params client, app, observed machine and size
 * @returns the observed machine when it already ran on the size, else the machine as started again
 * @throws {ProviderFault} when the size is not one Fly offers here
 */
export async function resizeMachine(params: ResizeParams): Promise<FlyMachine> {
  const { api, app, machine, offer } = params;
  const target = FLY_MACHINES.find(
    (candidate) =>
      candidate.label === offer.label &&
      candidate.cpus === offer.cpus &&
      candidate.memoryGb === offer.memoryGb,
  );
  if (!target) {
    throw new ProviderFault({
      code: 'failed',
      message: `Fly offers no machine ${offer.label} with ${String(offer.cpus)} CPUs and ${String(offer.memoryGb)} GB`,
    });
  }
  const wanted = guestOf(target);
  const { guest } = machine;
  if (
    guest?.cpuKind === wanted.cpuKind &&
    guest.cpus === wanted.cpus &&
    guest.memoryMb === wanted.memoryMb
  ) {
    return machine;
  }
  const updated = await api.updateMachine({ app, machine: machine.id }, wanted);

  return { ...machine, ...updated, state: 'started' };
}
