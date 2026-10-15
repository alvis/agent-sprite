import { driverModule } from '#guest/guest-root';

import type { GuestPayload } from '#drivers/contracts';

/** compiled module that checks the gateway's model catalogue */
export const HUB_PROBE_MODULE = driverModule(
  'shared/cliproxyapi',
  'hub-probe.js',
);

/** root-owned record of the gateway endpoint and client key the probe reads */
export const HUB_RECORD_FILE = 'cliproxyapi.json';

/** compiled guest modules the CLIProxyAPI hub client contributes */
export const CLIPROXYAPI_GUEST_MODULES: readonly GuestPayload[] = [
  { module: HUB_PROBE_MODULE, account: 'root' },
];
