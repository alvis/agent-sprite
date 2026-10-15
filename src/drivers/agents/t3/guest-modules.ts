import { driverModule } from '#guest/guest-root';

import type { GuestPayload } from '#drivers/contracts';

const folder = 'agents/t3';

/** compiled module that launches the T3 service */
export const T3_LAUNCHER_MODULE = driverModule(folder, 't3-launcher.js');

/** compiled module that reads the environment descriptor of the running T3 service */
export const T3_PROBE_MODULE = driverModule(folder, 't3-environment-probe.js');

/** compiled guest modules T3 Code contributes to the deployable payload */
export const T3_GUEST_MODULES: readonly GuestPayload[] = [
  { module: T3_LAUNCHER_MODULE, account: 'agent' },
  { module: T3_PROBE_MODULE, account: 'agent' },
];
