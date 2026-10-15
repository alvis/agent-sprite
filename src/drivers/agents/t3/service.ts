import { GUEST_NODE, GUEST_ROOT } from '#guest/guest-root';

import { T3_LAUNCHER_MODULE } from './guest-modules.js';

import type { ServiceDefinition } from '#drivers/guest-channel';

/** port the provider routes to the T3 service */
export const T3_HTTP_PORT = 3773;

/**
 * the T3 service; it lists no dependencies because core adds the daemon of
 * whichever network the workstation selected
 */
export const t3Service: ServiceDefinition = {
  name: 't3-code',
  command: GUEST_NODE,
  arguments: [`${GUEST_ROOT}/${T3_LAUNCHER_MODULE}`],
  account: 'agent',
  needs: [],
  httpPort: T3_HTTP_PORT,
};
