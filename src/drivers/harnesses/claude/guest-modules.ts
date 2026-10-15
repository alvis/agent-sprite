import { driverModule } from '#guest/guest-root';

import type { GuestPayload } from '#drivers/contracts';

const folder = 'harnesses/claude';

/** compiled module that reports whether Claude Code's plugins and notifications are initialised */
export const CLAUDE_INIT_PROBE_MODULE = driverModule(
  folder,
  'claude-init-probe.js',
);

/** compiled guest modules Claude Code contributes to the deployable payload */
export const CLAUDE_GUEST_MODULES: readonly GuestPayload[] = [
  {
    module: driverModule(folder, 'claude-init-notifications.js'),
    account: 'agent',
  },
  { module: CLAUDE_INIT_PROBE_MODULE, account: 'agent' },
];
