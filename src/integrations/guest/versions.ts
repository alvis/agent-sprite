import { runAsAgent } from './account.js';

import type { Sprite } from '@fly/sprites';

/**
 * queries installed guest tool versions without changing guest state
 * @param sprite target guest
 * @returns installed tool versions keyed by tool name
 */
export async function readInstalledVersions(
  sprite: Sprite,
): Promise<Record<string, string>> {
  const commands: Record<string, string[]> = {
    node: ['/usr/local/bin/node', '--version'],
    git: ['/usr/local/bin/git', '--version'],
    jj: ['/usr/local/bin/jj', '--version'],
    gh: ['/usr/local/bin/gh', '--version'],
    tailscale: ['/usr/local/bin/tailscale', 'version'],
    claude: ['/home/agent/.local/bin/claude', '--version'],
    codex: ['/home/agent/.local/bin/codex', '--version'],
    t3: ['/home/agent/.local/bin/t3', '--version'],
    bun: ['/home/agent/.local/bin/bun', '--version'],
  };
  const entries = await Promise.all(
    Object.entries(commands).map(async ([name, argv]) => {
      const result = await runAsAgent(sprite, argv);

      return [name, result.stdout.trim()] as const;
    }),
  );

  return Object.fromEntries(entries);
}
