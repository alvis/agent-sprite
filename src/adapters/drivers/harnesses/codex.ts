import { configureCodex } from './codex/configure';
import { codexHooks } from './codex/hooks';
import { codexReadiness, inspectCodex } from './codex/inspection';
import {
  CODEX_RESERVED_ENVIRONMENT,
  CODEX_SPAWN_ENVIRONMENT,
} from './codex/paths';
import { codexPlugins } from './codex/plugins';
import { codexTool } from './codex/tools';

import type { HarnessDriver } from '#application/ports/drivers';
import type { HarnessSkillEvidence } from '#domain/observations/harness';

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
