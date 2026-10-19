import { AGENT_BIN } from '#adapters/guest/platform/layout';

import type { ToolSpec } from '#domain/tools';

/** the Claude Code CLI, installed from npm by the agent with Homebrew's `node` */
export const claudeTool: ToolSpec = {
  name: 'claude',
  required: true,
  needs: ['node'],
  executables: ['claude'],
  version: {
    executable: `${AGENT_BIN}/claude`,
    args: ['--version'],
    account: 'agent',
  },
  sources: [
    { kind: 'npm', package: '@anthropic-ai/claude-code', account: 'agent' },
  ],
};
