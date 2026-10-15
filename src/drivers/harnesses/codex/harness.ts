import { configureCodex } from './configure.js';
import { codexGuestLeaf } from './guest-leaf.js';
import { codexHooks } from './hooks.js';
import { codexReadiness, inspectCodex } from './inspect.js';
import { CODEX_RESERVED_ENVIRONMENT } from './paths.js';
import { codexPlugins } from './plugins.js';

import type { HarnessDriver, HarnessSkillEvidence } from '#drivers/contracts';

/** Codex as a harness driver */
export const codex: HarnessDriver<'codex', HarnessSkillEvidence | undefined> = {
  id: 'codex',
  kind: 'harnesses',
  displayName: 'Codex',
  supportsProxy: true,
  ...codexGuestLeaf,
  plugins: codexPlugins,
  hooks: codexHooks,
  reservedEnvironment: CODEX_RESERVED_ENVIRONMENT,
  configure: configureCodex,
  inspect: inspectCodex,
  readiness: codexReadiness,
};
