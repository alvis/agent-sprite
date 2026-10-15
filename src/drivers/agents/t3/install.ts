import type { InstallSpec, ReleaseChannels } from '#drivers/contracts';

/** the T3 Code CLI installed from npm under the agent account */
export const t3Install: InstallSpec = {
  component: 't3',
  source: { kind: 'npm', package: 't3' },
  versionProbe: {
    program: '/home/agent/.local/bin/t3',
    arguments: ['--version'],
    account: 'agent',
  },
};

/** the runtime T3 Code needs beside its own package */
export const bunInstall: InstallSpec = {
  component: 'bun',
  source: { kind: 'npm', package: 'bun' },
  versionProbe: {
    program: '/home/agent/.local/bin/bun',
    arguments: ['--version'],
    account: 'agent',
  },
};

/** npm packages the T3 guest modules import; none, as they use only Node built-ins */
export const T3_GUEST_PACKAGES: readonly string[] = [];

/** the stable release follows npm's latest tag; the nightly follows the nightly tag */
export const T3_RELEASE_CHANNELS: ReleaseChannels = {
  channels: [
    { id: 'stable', distTag: 'latest' },
    { id: 'nightly', distTag: 'nightly' },
  ],
  defaultChannel: 'stable',
};
