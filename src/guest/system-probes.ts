// guest kernel: imports only other guest constants, so host code may import it (REQ-MAINT-5)

import { CHROME } from './chrome.js';
import { GUEST_NODE } from './guest-root.js';
import { HOMEBREW_TOOLS, TOOL_LINK_DIRECTORY } from './homebrew.js';
import { RUSTUP_ENVIRONMENT } from './rust.js';

import type { HomebrewTool } from './homebrew.js';

/** the program and arguments that report one tool's version, run as the agent account */
export type VersionProbe = readonly string[];

/** the probe of the Rust compiler, which finds the toolchain in the agent's home through rustup's proxy */
export const RUST_PROBE: VersionProbe = [
  '/usr/bin/env',
  ...RUSTUP_ENVIRONMENT,
  `${TOOL_LINK_DIRECTORY}/rustc`,
  '--version',
];

/** the probe of Google Chrome, which prints its full four-part version */
export const CHROME_PROBE: VersionProbe = [CHROME.command, '--version'];

/**
 * names the program and arguments that report the version of a tool poured from Homebrew
 * @param tool the tool and its linked command
 * @returns the linked command with `--version`, behind the assignments the tool asks for
 */
export function versionProbe(tool: HomebrewTool): VersionProbe {
  const { command, environment } = tool;
  const probe = [`${TOOL_LINK_DIRECTORY}/${command}`, '--version'];

  return environment ? ['/usr/bin/env', ...environment, ...probe] : probe;
}

/** the tools every workstation installs ahead of its drivers, keyed as the manifest records their versions */
export const SYSTEM_PROBES: ReadonlyArray<readonly [string, VersionProbe]> = [
  // open-agent's own Node, which the guest code runs on
  ['guest-node', [GUEST_NODE, '--version']],
  ...HOMEBREW_TOOLS.map((tool) => [tool.formula, versionProbe(tool)] as const),
  ['rust', RUST_PROBE],
  [CHROME.component, CHROME_PROBE],
];
