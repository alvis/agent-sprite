import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { isRecord } from '../../../../guest/records.js';

import type { NetworkComponent } from '../../../component-types.js';
import type {
  ReleaseInstaller,
  ReleaseInstallTools,
} from '../../../install-sources.js';

/** the stable Tailscale archive for this guest architecture */
interface TailscaleRelease {
  /** bare dotted version the archive carries */
  version: string;
  /** archive filename the feed lists */
  archive: string;
}

/**
 * reads the official stable Tailscale release for this guest architecture
 * @param network the recorded Tailscale release feed
 * @param tools installer helpers core lends
 * @returns the version and archive the feed lists
 */
async function readRelease(
  network: NetworkComponent,
  tools: ReleaseInstallTools,
): Promise<TailscaleRelease> {
  const release: unknown = JSON.parse(await tools.downloadText(network.feed));
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const archive =
    isRecord(release) && isRecord(release.Tarballs)
      ? release.Tarballs[arch]
      : undefined;
  const version =
    typeof archive === 'string'
      ? /^tailscale_(\d+\.\d+\.\d+)_[a-zA-Z0-9_.-]+\.tgz$/.exec(archive)?.[1]
      : undefined;
  if (typeof archive !== 'string' || version === undefined) {
    throw new Error('Tailscale release metadata is invalid');
  }

  return { version, archive };
}

/**
 * reads the version of the official stable Tailscale release
 * @param network the recorded Tailscale release feed
 * @param tools installer helpers core lends
 * @returns the version the feed lists for this architecture
 */
export const latestRelease = (async (network, tools) =>
  (await readRelease(network, tools))
    .version) satisfies ReleaseInstaller['latestRelease'];

/**
 * installs the official stable Tailscale archive for this guest architecture
 * @param network the recorded Tailscale release feed
 * @param tools installer helpers core lends
 * @param version the version `latestRelease` returned
 */
export const installRelease = (async (network, tools, version) => {
  const { download, link, run, temporary, toolsDirectory } = tools;
  const release = await readRelease(network, tools);
  if (release.version !== version) {
    throw new Error('Tailscale release changed while it was being installed');
  }
  // only the Tailscale launcher and status checks run `ip`, so a workstation
  // without Tailscale installs no routing tools
  await run('/usr/bin/apt-get', [
    'install',
    '-y',
    '-qq',
    '--no-upgrade',
    '--no-install-recommends',
    'iproute2',
  ]);
  await download(new URL(release.archive, network.feed).href, 'tailscale.tgz');
  await run('/usr/bin/tar', [
    '-xzf',
    join(temporary, 'tailscale.tgz'),
    '-C',
    temporary,
  ]);
  const extracted = (await readdir(temporary)).find((name) =>
    name.startsWith('tailscale_'),
  );
  if (!extracted) {
    throw new Error('Tailscale archive is incomplete');
  }
  for (const tool of ['tailscale', 'tailscaled']) {
    await run('/usr/bin/install', [
      '-m',
      '0755',
      join(temporary, extracted, tool),
      `${toolsDirectory}/${tool}`,
    ]);
    await link(`${toolsDirectory}/${tool}`, `/usr/local/bin/${tool}`);
  }
}) satisfies ReleaseInstaller['installRelease'];
