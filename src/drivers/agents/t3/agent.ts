import { inspectT3Environment } from './evidence.js';
import { T3_HARNESSES } from './harness-names.js';
import { pairT3 } from './pairing.js';
import { t3Readiness } from './readiness.js';
import { T3_LAUNCHER, t3Service } from './service.js';
import { verifyT3Startup } from './startup.js';
import { T3_TOOLS } from './tools.js';

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
  // the stable release follows npm's latest tag; the nightly follows the nightly tag
  releaseChannels: {
    channels: [
      { id: 'stable', distTag: 'latest' },
      { id: 'nightly', distTag: 'nightly' },
    ],
    defaultChannel: 'stable',
  },
  tools: T3_TOOLS,
  service: t3Service,
  launcher: T3_LAUNCHER,
  inspectEnvironment: inspectT3Environment,
  pair: pairT3,
  verifyStartup: verifyT3Startup,
  readiness: t3Readiness,
};
