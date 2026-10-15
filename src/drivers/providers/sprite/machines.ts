import type { MachineOffer } from '#drivers/contracts';

/** the one size a Sprite has: Fly Sprites supports at most 8 CPUs and 16 GB, and configures none */
export const SPRITE_MACHINE: MachineOffer = {
  label: 'sprite',
  cpus: 8,
  memoryGb: 16,
};
