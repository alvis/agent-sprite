import { execFileSync } from 'node:child_process';

import { resolveTrustedFile } from './native-files.js';

const probes = [
  ['node', ['/usr/local/bin/node', '--version']],
  ['git', ['/usr/local/bin/git', '--version']],
  ['jj', ['/usr/local/bin/jj', '--version']],
  ['gh', ['/usr/local/bin/gh', '--version']],
  ['tailscale', ['/usr/local/bin/tailscale', 'version']],
  ['claude', ['/home/agent/.local/bin/claude', '--version']],
  ['codex', ['/home/agent/.local/bin/codex', '--version']],
  ['t3', ['/home/agent/.local/bin/t3', '--version']],
  ['bun', ['/home/agent/.local/bin/bun', '--version']],
] as const;

/**
 * probes installed versions through the unprivileged guest account
 * @param environment fixed guest process environment
 * @param onStep records the exact failing probe
 * @returns installed version map
 */
export async function probeInstalledVersions(
  environment: NodeJS.ProcessEnv,
  onStep: (step: string) => void,
): Promise<Record<string, string>> {
  const runuser = await resolveTrustedFile('/usr/sbin/runuser');

  return Object.fromEntries(
    probes.map(([name, command]) => {
      onStep(`installed version probe (${name})`);

      return [
        name,
        execFileSync(runuser, ['-u', 'agent', '--', ...command], {
          env: environment,
          encoding: 'utf8',
          timeout: 10_000,
        }).trim(),
      ];
    }),
  );
}
