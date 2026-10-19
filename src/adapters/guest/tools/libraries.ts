import { guestAsset } from '#adapters/guest/platform/assets';
import { ROOT_ONLY_MODE } from '#domain/guest';

/** the Homebrew helpers: install Homebrew, and install, upgrade and probe formulae from their bottles */
export const HOMEBREW_LIBRARY = guestAsset(
  'tools/homebrew/lib.sh',
  ROOT_ONLY_MODE,
);

/** the npm helpers: install and upgrade the agent's npm tools at a dist-tag */
export const NPM_LIBRARY = guestAsset('tools/npm/lib.sh', ROOT_ONLY_MODE);

/** the rustup helpers: install and update the agent's Rust toolchain */
export const RUSTUP_LIBRARY = guestAsset('tools/rustup/lib.sh', ROOT_ONLY_MODE);

/** the link helpers: link Homebrew tools' executables into `/usr/local/bin` and restore them */
export const LINKS_LIBRARY = guestAsset('tools/links.sh', ROOT_ONLY_MODE);

/** the official Homebrew installer, pinned to a commit and its digest */
export const HOMEBREW_INSTALLER = {
  url: 'https://raw.githubusercontent.com/Homebrew/install/7a3f48c7e498d7df3237fd41c30f4d492857edf4/install.sh',
  sha256: '5f333bbe53bc490e51e7ccb1df8779b3dd6ee73a1a7379efda216edb08ccb148',
} as const;

/**
 * the Homebrew release every guest runs: Homebrew/brew's latest stable tag on
 * 2026-10-16 and the commit it names. Setup checks it out after the
 * installer, which leaves the newest tag, and the updater refreshes only
 * formula data, never Homebrew's own code, so a newer release arrives only
 * with an open-agent release that names it, the next time setup runs
 */
export const HOMEBREW_RELEASE = {
  tag: '7.0.9',
  commit: 'cdc1ca503231b9a96da64526774915d913c3ec9f',
} as const;

/** the prefix of each line the bottle probe prints for a formula with no bottle for the guest */
export const NO_BOTTLE_PREFIX = 'no-bottle:';
