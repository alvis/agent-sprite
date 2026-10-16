import { guestAsset } from '#integrations/guest/assets';
import { SHARED_MODE } from '#os/contracts';

import type { ServiceDefinition } from '#drivers/guest-channel';

/** port the provider routes to the T3 service */
export const T3_HTTP_PORT = 3773;

/** the launcher the T3 service runs as the agent, which reads its port and harnesses from environment.json */
export const T3_LAUNCHER = guestAsset(
  'drivers/agents/t3/launcher.sh',
  SHARED_MODE,
);

/**
 * the T3 service; it lists no dependencies because core adds the daemon of
 * whichever network the workstation selected
 */
export const t3Service: ServiceDefinition = {
  name: 't3-code',
  command: '/bin/sh',
  arguments: [T3_LAUNCHER.installAs],
  account: 'agent',
  needs: [],
  httpPort: T3_HTTP_PORT,
};
