import type { InstallSpec } from '#drivers/contracts';

/** the Claude Code CLI installed from npm under the agent account */
export const claudeInstall: InstallSpec = {
  component: 'claude',
  source: { kind: 'npm', package: '@anthropic-ai/claude-code' },
  versionProbe: {
    program: '/home/agent/.local/bin/claude',
    arguments: ['--version'],
    account: 'agent',
  },
};
