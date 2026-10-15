import type { ReleaseChannels } from '#drivers/contracts';

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
