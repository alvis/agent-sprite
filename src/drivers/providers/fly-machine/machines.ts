import type { MachineOffer } from '#drivers/contracts';

import type { FlyGuest } from './wire';

/** one Fly machine preset a workstation can run on */
export interface FlyMachineOffer extends MachineOffer {
  /** the CPU kind the Machines API names the preset by */
  cpuKind: FlyGuest['cpuKind'];
}

const MEGABYTES_PER_GIGABYTE = 1_024;

/**
 * the Fly presets a workstation can run on, cheapest first and in whole
 * gigabytes from 2 GB up. Every row is a memory size its preset allows (see
 * https://fly.io/docs/machines/guides-examples/machine-sizing/): shared-cpu-2x
 * 512 MB to 4 GB, shared-cpu-4x 1 GB to 8 GB, shared-cpu-8x 2 GB to 16 GB,
 * performance-4x 8 GB to 32 GB, performance-8x 16 GB to 64 GB and
 * performance-16x 32 GB to 128 GB. The table starts at shared-cpu-2x, the
 * default size; shared-cpu-1x and performance-1x and 2x are not offered
 */
export const FLY_MACHINES: readonly FlyMachineOffer[] = [
  { label: 'shared-cpu-2x', cpuKind: 'shared', cpus: 2, memoryGb: 2 },
  { label: 'shared-cpu-4x', cpuKind: 'shared', cpus: 4, memoryGb: 2 },
  { label: 'shared-cpu-8x', cpuKind: 'shared', cpus: 8, memoryGb: 2 },
  { label: 'shared-cpu-2x', cpuKind: 'shared', cpus: 2, memoryGb: 4 },
  { label: 'shared-cpu-4x', cpuKind: 'shared', cpus: 4, memoryGb: 4 },
  { label: 'shared-cpu-8x', cpuKind: 'shared', cpus: 8, memoryGb: 4 },
  { label: 'shared-cpu-4x', cpuKind: 'shared', cpus: 4, memoryGb: 8 },
  { label: 'shared-cpu-8x', cpuKind: 'shared', cpus: 8, memoryGb: 8 },
  { label: 'shared-cpu-8x', cpuKind: 'shared', cpus: 8, memoryGb: 16 },
  { label: 'performance-4x', cpuKind: 'performance', cpus: 4, memoryGb: 32 },
  { label: 'performance-8x', cpuKind: 'performance', cpus: 8, memoryGb: 32 },
  { label: 'performance-16x', cpuKind: 'performance', cpus: 16, memoryGb: 32 },
  { label: 'performance-8x', cpuKind: 'performance', cpus: 8, memoryGb: 64 },
  { label: 'performance-16x', cpuKind: 'performance', cpus: 16, memoryGb: 64 },
  { label: 'performance-16x', cpuKind: 'performance', cpus: 16, memoryGb: 128 },
];

/**
 * names the machine size a guest runs on
 * @param guest guest the Machines API reports
 * @returns the preset name, CPUs and memory in gigabytes
 */
export function describeGuest(guest: FlyGuest): MachineOffer {
  return {
    label:
      guest.cpuKind === 'shared'
        ? `shared-cpu-${guest.cpus}x`
        : `${guest.cpuKind}-${guest.cpus}x`,
    cpus: guest.cpus,
    memoryGb: guest.memoryMb / MEGABYTES_PER_GIGABYTE,
  };
}

/**
 * renders a preset as the guest the Machines API takes
 * @param offer preset to run on
 * @returns the guest description
 */
export function guestOf(offer: FlyMachineOffer): FlyGuest {
  return {
    cpuKind: offer.cpuKind,
    cpus: offer.cpus,
    memoryMb: offer.memoryGb * MEGABYTES_PER_GIGABYTE,
  };
}
