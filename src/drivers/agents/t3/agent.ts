import { inspectT3Environment } from './evidence.js';
import { t3GuestLeaf } from './guest-leaf.js';
import { T3_HARNESSES } from './harness-names.js';
import { pairT3 } from './pairing.js';
import { t3Readiness } from './readiness.js';
import { verifyT3Startup } from './startup.js';

import type { HarnessId } from '#core/catalog';
import type { AgentDriver } from '#drivers/contracts';

import type { T3Environment } from './evidence.js';

/** T3 Code as an ACP agent driver */
export const t3: AgentDriver<'t3', HarnessId, T3Environment> = {
  id: 't3',
  kind: 'agents',
  displayName: 'T3 Code',
  supportedHarnesses: T3_HARNESSES,
  harnessLaunchMode: 'native-cli',
  supportsPairing: true,
  releaseChannels: t3GuestLeaf.releaseChannels,
  install: t3GuestLeaf.install,
  runtime: t3GuestLeaf.runtime,
  guestPackages: t3GuestLeaf.guestPackages,
  guest: t3GuestLeaf.guest,
  service: t3GuestLeaf.service,
  inspectEnvironment: inspectT3Environment,
  pair: pairT3,
  verifyStartup: verifyT3Startup,
  readiness: t3Readiness,
};
