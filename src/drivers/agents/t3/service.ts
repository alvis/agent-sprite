import { guestAsset } from '#integrations/guest/assets';
import {
  AGENT_HOME,
  SERVICE_STATE_DIRECTORY,
} from '#integrations/guest/layout';
import { SHARED_MODE } from '#os/contracts';

import type { ServiceDefinition } from '#drivers/guest-channel';

/** name of the T3 service, which names its runit directory, its log and its runtime state */
const T3_SERVICE_NAME = 't3-code';

/** port the provider routes to the T3 service */
export const T3_HTTP_PORT = 3773;

/** T3's base directory, where it keeps its state and credentials */
export const T3_HOME = `${AGENT_HOME}/.t3`;

/** megabytes the agent's home must have free for the launcher to start T3, below which T3 cannot write its database and would only crash-loop */
const T3_MIN_FREE_MB = 64;

/** where T3 records its running server, which a stop can leave naming a process id another process holds after the next boot */
export const T3_SERVER_RECORD = `${T3_HOME}/userdata/server-runtime.json`;

/**
 * where the launcher captures T3's stderr, in the service's private runtime
 * state the runit backend makes for it on memory-backed storage; the backend's
 * finish hook forwards only the redacted error headers of it to the service's
 * exit line, and a backend that makes no such directory gets no capture
 */
const T3_STDERR_CAPTURE = `${SERVICE_STATE_DIRECTORY}/${T3_SERVICE_NAME}/stderr`;

/** the launcher the T3 service runs as the agent, which reads its port and harnesses from environment.json */
export const T3_LAUNCHER = guestAsset(
  'drivers/agents/t3/launcher.sh',
  SHARED_MODE,
  {
    OA_T3_HOME: T3_HOME,
    OA_T3_MIN_FREE_MB: String(T3_MIN_FREE_MB),
    OA_T3_SERVER_RECORD: T3_SERVER_RECORD,
    OA_T3_STDERR_CAPTURE: T3_STDERR_CAPTURE,
  },
);

/**
 * the T3 service; it lists no dependencies because core adds the daemon of
 * whichever network the workstation selected
 */
export const t3Service: ServiceDefinition = {
  name: T3_SERVICE_NAME,
  command: '/bin/sh',
  arguments: [T3_LAUNCHER.installAs],
  account: 'agent',
  needs: [],
  httpPort: T3_HTTP_PORT,
};
