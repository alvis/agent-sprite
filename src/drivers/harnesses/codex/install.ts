import type { InstallSpec } from '#drivers/contracts';

/** the Codex CLI installed from npm under the agent account */
export const codexInstall: InstallSpec = {
  component: 'codex',
  source: { kind: 'npm', package: '@openai/codex' },
  versionProbe: {
    program: '/home/agent/.local/bin/codex',
    arguments: ['--version'],
    account: 'agent',
  },
};
