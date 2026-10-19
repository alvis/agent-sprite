import { createGuestMechanics } from '#adapters/guest/mechanics';
import { createHostPorts } from '#adapters/host/ports';

import { defaults } from './defaults';
import { registry } from './registry';

import type { ApplicationDependencies } from '#application/ports/dependencies';

/**
 * wires the registered drivers, defaults, guest mechanics and host ports the application runs on
 * @returns the dependencies every workflow receives
 */
export function createDependencies(): ApplicationDependencies {
  return {
    registry,
    defaults,
    guest: createGuestMechanics({ registry, defaults }),
    host: createHostPorts(),
  };
}
