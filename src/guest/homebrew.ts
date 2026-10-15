// guest kernel: constants only, so host code may import it (REQ-MAINT-5)

import { GUEST_ROOT } from './guest-root.js';
import { RUSTUP_ENVIRONMENT } from './rust.js';

const HOME = '/home/linuxbrew';
const PREFIX = `${HOME}/.linuxbrew`;

/**
 * every path of Homebrew on Linux on a workstation: bottles pour only at the
 * default prefix, any other prefix would build from source, and the prefix
 * belongs to a dedicated system account the agent account cannot write as.
 * Every path derives from the account's home, so a provider that keeps the
 * root filesystem only until a cold boot can keep that home, which holds the
 * prefix and Homebrew's cache, on its volume
 */
export const HOMEBREW = {
  /** system account that owns the prefix and runs every brew command; created with no login shell and no sudo rule, and refused in an administrative group */
  account: 'linuxbrew',
  /** the account's home, holding the prefix and Homebrew's download cache */
  home: HOME,
  /** the default prefix, the only one bottles pour at */
  prefix: PREFIX,
  /** the brew command */
  brew: `${PREFIX}/bin/brew`,
  /** the GitHub CLI in its keg's `opt` link, which `/usr/local/bin/gh` points to and which only the Homebrew account can change */
  gh: `${PREFIX}/opt/gh/bin/gh`,
} as const;

/** where a workstation links the commands of every installed tool */
export const TOOL_LINK_DIRECTORY = '/usr/local/bin';

/** root-owned record on the persistent guest root of every link the installer makes in `TOOL_LINK_DIRECTORY`, one `path<TAB>target` line each, from which a provider that rebuilds its root filesystem on boot restores them */
export const TOOL_LINK_RECORD = `${GUEST_ROOT}/links`;

/** commands of one directory of a keg's `opt` link that `/usr/local/bin` links to */
export interface HomebrewLinks {
  /** the directory, relative to the keg's `opt` link */
  directory: string;
  /** the commands to link; every command the directory holds when omitted */
  commands?: readonly string[];
}

/** a formula a workstation pours from its bottle, and the commands it links */
export interface HomebrewTool {
  /** the formula's name, or the alias that follows the current release, such as `python3`; also the key of the tool's install outcome and recorded version */
  formula: string;
  /** the commands linked from the keg's `opt` link, which Homebrew keeps for every installed keg, even a keg-only one */
  links: readonly HomebrewLinks[];
  /** the linked command that reports the tool's version when run with `--version`; the tool counts as installed only while its link resolves into the prefix */
  command: string;
  /** assignments the version probe runs with */
  environment?: readonly string[];
}

/** every formula a workstation pours, in the order they install */
export const HOMEBREW_TOOLS: readonly HomebrewTool[] = [
  {
    formula: 'git',
    links: [{ directory: 'bin', commands: ['git'] }],
    command: 'git',
  },
  {
    formula: 'jj',
    links: [{ directory: 'bin', commands: ['jj'] }],
    command: 'jj',
  },
  {
    formula: 'gh',
    links: [{ directory: 'bin', commands: ['gh'] }],
    command: 'gh',
  },
  {
    // Homebrew's own Node, on the Current line; open-agent runs on the
    // private Node under the guest root instead
    formula: 'node',
    links: [{ directory: 'bin', commands: ['node', 'npm', 'npx'] }],
    command: 'node',
  },
  {
    formula: 'pnpm',
    links: [{ directory: 'bin', commands: ['pnpm', 'pnpx'] }],
    command: 'pnpm',
  },
  {
    // the alias moves to each new minor Python; the unversioned commands
    // are in `libexec/bin`, which Homebrew leaves off its own PATH
    formula: 'python3',
    links: [
      { directory: 'bin', commands: ['python3', 'pip3'] },
      { directory: 'libexec/bin', commands: ['python', 'pip'] },
    ],
    command: 'python3',
  },
  {
    formula: 'uv',
    links: [{ directory: 'bin', commands: ['uv', 'uvx'] }],
    command: 'uv',
  },
  {
    // keg-only: `bin` holds rustup and its proxies for the toolchain's
    // commands, which find the toolchain in the agent's own home
    formula: 'rustup',
    links: [{ directory: 'bin' }],
    command: 'rustup',
    environment: RUSTUP_ENVIRONMENT,
  },
  {
    formula: 'httpie',
    links: [{ directory: 'bin', commands: ['http', 'https', 'httpie'] }],
    command: 'http',
  },
];
