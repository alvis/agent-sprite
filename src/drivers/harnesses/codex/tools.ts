import { AGENT_BIN } from '#integrations/guest/layout';

import type { ToolSpec } from '#tools/contracts';

/** the Codex CLI, installed from npm by the agent with Homebrew's `node` */
export const codexTool: ToolSpec = {
  name: 'codex',
  required: true,
  needs: ['node'],
  executables: ['codex'],
  version: {
    executable: `${AGENT_BIN}/codex`,
    args: ['--version'],
    account: 'agent',
  },
  sources: [{ kind: 'npm', package: '@openai/codex', account: 'agent' }],
};
