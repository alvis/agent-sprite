import { AGENT_BIN } from '#adapters/guest/platform/layout';

import type { ToolSpec } from '#domain/tools';

/** the T3 Code CLI, installed from npm by the agent at its release channel's dist-tag */
export const t3Tool: ToolSpec = {
  name: 't3',
  required: true,
  needs: ['node'],
  executables: ['t3'],
  version: {
    executable: `${AGENT_BIN}/t3`,
    args: ['--version'],
    account: 'agent',
  },
  sources: [{ kind: 'npm', package: 't3', account: 'agent' }],
};

/** the Bun runtime T3 Code needs beside its own package, installed from npm by the agent */
const bunTool: ToolSpec = {
  name: 'bun',
  required: true,
  needs: ['node'],
  executables: ['bun'],
  version: {
    executable: `${AGENT_BIN}/bun`,
    args: ['--version'],
    account: 'agent',
  },
  sources: [{ kind: 'npm', package: 'bun', account: 'agent' }],
};

/** every tool T3 Code needs: its CLI, then its runtime */
export const T3_TOOLS: readonly ToolSpec[] = [t3Tool, bunTool];
