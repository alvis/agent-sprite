import { TOOL_LINK_DIRECTORY } from '../homebrew.js';
import { RUST_CHANNEL } from '../rust.js';
import { RUST_PROBE } from '../system-probes.js';

import { probeVersion, runAsAgent, versionOf } from './agent.js';

import type { ReleaseInstallTools } from '../../drivers/install-sources.js';

import type { ComponentInstall, ResolvedRelease } from './ledger.js';

const RUSTUP = `${TOOL_LINK_DIRECTORY}/rustup`;
// the manifest rustup itself reads to learn the channel's release
const MANIFEST = `https://static.rust-lang.org/dist/channel-rust-${RUST_CHANNEL}.toml`;
const RELEASE = /^\[pkg\.rust\]\r?\nversion = "([^"]+)"/mu;
const TOOLCHAIN = new RegExp(`^${RUST_CHANNEL}-`, 'mu');
// no documentation, and only the components a build and its checks use
const TOOLCHAIN_OPTIONS = [
  '--profile',
  'minimal',
  '--component',
  'clippy,rustfmt',
];

/**
 * describes the Rust toolchain of the agent account, which rustup keeps in the
 * agent's home and which the proxies rustup links in `/usr/local/bin` run
 * @param tools installer helpers core lends
 * @returns how the ledger resolves, probes and installs the toolchain
 */
export function rustComponent(
  tools: ReleaseInstallTools,
): ComponentInstall<ResolvedRelease> {
  return {
    component: 'rust',
    resolve: async () => ({
      version: releaseOf(await tools.downloadText(MANIFEST)),
    }),
    // the compiler only when the toolchain is there, since a proxy would
    // otherwise be asked for one that rustup could be left to fetch
    installed: async () =>
      (await hasToolchain(tools))
        ? probeVersion(tools.run, RUST_PROBE)
        : undefined,
    install: async () => {
      if (await hasToolchain(tools)) {
        await runAsAgent(tools.run, [RUSTUP, 'update', RUST_CHANNEL]);
      } else {
        await runAsAgent(tools.run, [
          RUSTUP,
          'toolchain',
          'install',
          RUST_CHANNEL,
          ...TOOLCHAIN_OPTIONS,
        ]);
      }
      await runAsAgent(tools.run, [RUSTUP, 'default', RUST_CHANNEL]);
    },
  };
}

/**
 * tells whether the agent account has the channel's toolchain installed
 * @param tools installer helpers core lends
 * @returns whether rustup lists the toolchain
 */
async function hasToolchain(tools: ReleaseInstallTools): Promise<boolean> {
  try {
    return TOOLCHAIN.test(
      await runAsAgent(tools.run, [RUSTUP, 'toolchain', 'list'], {
        capture: true,
      }),
    );
  } catch {
    return false;
  }
}

/**
 * reads the compiler release the channel's manifest lists
 * @param manifest the channel manifest's text
 * @returns the dotted version of the release
 * @throws {Error} when the manifest lists no compiler release
 */
function releaseOf(manifest: string): string {
  const listed = RELEASE.exec(manifest)?.[1];
  const version = listed === undefined ? undefined : versionOf(listed);
  if (!version) {
    throw new Error(`The ${RUST_CHANNEL} Rust release is not listed`);
  }

  return version;
}
