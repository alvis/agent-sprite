import type { ProfileDefaults } from '#domain/profile';

import type { DriverRegistry } from './drivers';
import type { GuestMechanics } from './guest';
import type { HostPorts } from './host';

/** everything a workflow reaches the outside through, supplied once by the composition root */
export interface ApplicationDependencies {
  /** the registered drivers of every kind */
  registry: DriverRegistry;
  /** the selection and options a workstation starts from */
  defaults: ProfileDefaults;
  /** the guest operations drivers and setup run over a channel */
  guest: GuestMechanics;
  /** the local computer: processes, files, credentials and the network */
  host: HostPorts;
}
