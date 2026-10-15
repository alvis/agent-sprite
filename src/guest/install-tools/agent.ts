import { AGENT_HOME } from '../guest-root.js';

import type { ReleaseInstallTools } from '../../drivers/install-sources.js';

/** how a component installer runs a root-controlled tool */
export type RunTool = ReleaseInstallTools['run'];

const VERSION = /\d{1,9}\.\d{1,9}\.\d{1,9}/;
/** the search path the agent account's own sessions have, with Homebrew's Node and not open-agent's private one */
export const AGENT_PATH = `${AGENT_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`;

/**
 * reads the dotted version a tool reports about itself, without any build
 * suffix such as the commit id jj appends
 * @param output text a version probe or a registry printed
 * @returns the first dotted version in the text, or nothing when it holds none
 */
export function versionOf(output: string): string | undefined {
  return VERSION.exec(output)?.[0];
}

/** how a program runs as the agent account */
export interface AgentRun {
  /** whether the caller consumes the output */
  capture?: boolean;
  /** the search path the program has, the agent account's own unless another is given */
  path?: string;
}

/**
 * runs a program only as the unprivileged agent account
 * @param run the root-controlled runner
 * @param argv program and arguments
 * @param options how the program runs
 * @param options.capture whether the caller consumes the output
 * @param options.path the search path the program has, the agent account's own unless another is given
 * @returns captured output or an empty string
 */
export async function runAsAgent(
  run: RunTool,
  argv: readonly string[],
  options: AgentRun = {},
): Promise<string> {
  const { capture = false, path = AGENT_PATH } = options;

  return run(
    '/usr/sbin/runuser',
    ['-u', 'agent', '--', '/usr/bin/env', `PATH=${path}`, ...argv],
    capture,
  );
}

/**
 * probes the version a root-owned component reports, as root, the way the
 * Node gate probes Node
 * @param run the root-controlled runner
 * @param command absolute program and arguments whose output reports the version
 * @returns the reported version, or nothing when the program is absent, fails or reports none
 */
export async function probeVersionAsRoot(
  run: RunTool,
  command: readonly string[],
): Promise<string | undefined> {
  const [program, ...args] = command;
  if (program === undefined) {
    return undefined;
  }
  try {
    return versionOf(await run(program, args, true));
  } catch {
    return undefined;
  }
}

/**
 * probes the version an agent-owned component reports, as the account that uses it
 * @param run the root-controlled runner
 * @param command program and arguments whose output reports the version
 * @returns the reported version, or nothing when the program is absent, fails or reports none
 */
export async function probeVersion(
  run: RunTool,
  command: readonly string[],
): Promise<string | undefined> {
  try {
    return versionOf(await runAsAgent(run, command, { capture: true }));
  } catch {
    return undefined;
  }
}
