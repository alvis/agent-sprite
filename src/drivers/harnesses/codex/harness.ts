import { configureCodex } from './configure';
import { codexHooks } from './hooks';
import { codexReadiness, inspectCodex } from './inspect';
import { CODEX_RESERVED_ENVIRONMENT, CODEX_SPAWN_ENVIRONMENT } from './paths';
import { codexPlugins } from './plugins';
import { codexTool } from './tools';

import type { HarnessDriver } from '#drivers/contracts';
import type { HarnessSkillEvidence } from '#drivers/harness-evidence';

/** Codex as a harness driver */
export const codex: HarnessDriver<'codex', HarnessSkillEvidence | undefined> = {
  id: 'codex',
  kind: 'harnesses',
  displayName: 'Codex',
  supportsProxy: true,
  tools: [codexTool],
  spawnEnvironment: CODEX_SPAWN_ENVIRONMENT,
  plugins: codexPlugins,
  hooks: codexHooks,
  reservedEnvironment: CODEX_RESERVED_ENVIRONMENT,
  configure: configureCodex,
  inspect: inspectCodex,
  readiness: codexReadiness,
};
