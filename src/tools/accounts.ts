import { AGENT_HOME } from '#guest/guest-root';

import type { ToolOwner } from './contracts.js';

/** home of the system account that owns the Homebrew prefix */
export const LINUXBREW_HOME = '/home/linuxbrew';

/** the default Homebrew prefix, the only one bottles pour at */
export const HOMEBREW_PREFIX = `${LINUXBREW_HOME}/.linuxbrew`;

/**
 * the system's own command directories, which every PATH root runs with
 * searches before `/usr/local`, so no Homebrew tool link shadows a command
 * the system provides
 */
export const SYSTEM_PATH = '/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * the directories Homebrew links its formulae's executables into, which the
 * agent's PATH searches before the system's. Root runs a formula's binaries,
 * such as runit's and tailscaled, only because the Homebrew account is a
 * locked system account root alone writes, acting as it; the agent account
 * never writes anything root runs
 */
export const HOMEBREW_PATH = `${HOMEBREW_PREFIX}/bin:${HOMEBREW_PREFIX}/sbin`;

/** the GitHub CLI in its keg's `opt` link, which only the Homebrew account can change */
export const HOMEBREW_GH = `${HOMEBREW_PREFIX}/opt/gh/bin/gh`;

/** where every tool owner's commands start, its home */
export const OWNER_HOMES: Readonly<Record<ToolOwner, string>> = {
  root: '/root',
  linuxbrew: LINUXBREW_HOME,
  agent: AGENT_HOME,
};
