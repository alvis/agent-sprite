import { inspectT3Environment } from './evidence';
import { pairT3 } from './pairing';
import { t3Readiness } from './readiness';
import { T3_LAUNCHER, t3Service } from './service';
import { verifyT3Startup } from './startup';
import { T3_TOOLS } from './tools';

import type { HarnessId } from '#core/catalog';
import type { AgentDriver } from '#drivers/contracts';

import type { T3Environment } from './evidence';

/**
 * how T3 names each harness it supports in its provider list, keyed by
 * harness driver id; the single list of the harnesses T3 supports, so a
 * harness without an entry is unsupported, and the agent driver's
 * `supportedHarnesses` checks every key is a registered harness
 */
const T3_HARNESS_NAMES = {
  claude: 'claudeAgent',
  codex: 'codex',
} as const;

/** a harness T3 supports */
type T3HarnessId = keyof typeof T3_HARNESS_NAMES;

/** the harnesses T3 supports, in the order T3_HARNESS_NAMES lists them */
const T3_HARNESSES: readonly T3HarnessId[] = Object.keys(
  T3_HARNESS_NAMES,
).filter((id): id is T3HarnessId => Object.hasOwn(T3_HARNESS_NAMES, id));

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
