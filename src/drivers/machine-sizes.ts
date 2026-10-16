import type { MachineOffer, MachineRequirement } from './contracts';

/**
 * picks the smallest machine that meets a requirement
 * @param offers machine sizes in the provider's order, cheapest first
 * @param requirement minimum CPUs and memory
 * @returns the first offer meeting both minimums, or undefined when none does
 */
export function pickMachine<Offer extends MachineOffer>(
  offers: readonly Offer[],
  requirement: MachineRequirement,
): Offer | undefined {
  return offers.find(
    (offer) =>
      offer.cpus >= requirement.cpus && offer.memoryGb >= requirement.memoryGb,
  );
}

/**
 * finds the largest CPU count and memory a provider offers
 * @param offers machine sizes the provider offers
 * @returns the largest CPU count and the largest memory, each from any offer
 */
export function largestMachine(
  offers: readonly MachineOffer[],
): MachineRequirement {
  return {
    cpus: Math.max(...offers.map((offer) => offer.cpus)),
    memoryGb: Math.max(...offers.map((offer) => offer.memoryGb)),
  };
}

/**
 * tells whether a workstation already runs on a machine size
 * @param current size the provider reports, absent when it reports none
 * @param offer size to compare with
 * @returns true when the provider reports exactly this size
 */
export function isSameMachine(
  current: MachineOffer | undefined,
  offer: MachineOffer,
): boolean {
  return (
    current?.label === offer.label &&
    current.cpus === offer.cpus &&
    current.memoryGb === offer.memoryGb
  );
}
