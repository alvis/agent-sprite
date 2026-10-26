import { AGENT_HOME } from '#adapters/guest/platform/layout';

import { HOMEBREW } from '../layout';
import { sleep } from '../timing';

import type { MachineProvider } from '../providers';

/** the agent's npm prefix */
export const NPM_PREFIX = `${AGENT_HOME}/.local`;

/** directory containing Homebrew's Node binary */
export const HOMEBREW_NODE = `${HOMEBREW.prefix}/opt/node/bin`;

/** how long a detached root script may run before the proof gives up on it */
const DETACHED_TIMEOUT_MS = 600_000;

/** delay between checks of a detached guest script */
export const DETACHED_POLL_MS = 3_000;

// enough of a failed script's output to name the failure
const DETACHED_OUTPUT_CHARS = 2000;

/**
 * runs a root script that may outlast one provider request: it runs detached
 * in the guest, and this waits for its exit status and output
 * @param provider selected provider
 * @param name exact workstation name
 * @param script shell script to run as root
 * @returns the script's output
 * @throws {Error} when the script exits non-zero or does not end in time
 */
export async function asRootDetached(
  provider: MachineProvider,
  name: string,
  script: string,
): Promise<string> {
  const directory = (
    await asRoot(
      provider,
      name,
      [
        'set -e',
        'dir=$(mktemp -d)',
        `echo ${Buffer.from(script).toString('base64')} | base64 -d > "$dir/run.sh"`,
        `setsid nohup /bin/sh -c '/bin/sh "$1/run.sh" > "$1/out" 2>&1; echo $? > "$1/exit.new"; mv "$1/exit.new" "$1/exit"' sh "$dir" </dev/null >/dev/null 2>&1 &`,
        'echo "$dir"',
      ].join('\n'),
    )
  ).trim();
  const deadline = Date.now() + DETACHED_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = (
      await asRoot(provider, name, `cat ${directory}/exit 2>/dev/null || true`)
    ).trim();
    if (status !== '') {
      const output = await asRoot(
        provider,
        name,
        `cat ${directory}/out; rm -rf ${directory}`,
      );
      if (status !== '0') {
        throw new Error(
          `Detached guest script exited ${status}: ${output.slice(-DETACHED_OUTPUT_CHARS)}`,
        );
      }

      return output;
    }
    await sleep(DETACHED_POLL_MS);
  }
  throw new Error('The detached guest script did not end in time');
}

/**
 * runs a script as root in the guest, whose exec account is not root
 * @param provider selected provider
 * @param name exact workstation name
 * @param script shell script to run
 * @returns the script's output
 */
export async function asRoot(
  provider: MachineProvider,
  name: string,
  script: string,
): Promise<string> {
  return provider.execute(
    name,
    `exec /usr/bin/sudo -n /bin/sh -c '${script.replaceAll("'", "'\\''")}'`,
  );
}

/**
 * runs a command as the agent account with the environment npm needs:
 * Homebrew's Node and the agent's npm prefix
 * @param command shell command line
 * @returns a root script that runs it
 */
export function asAgentWithNode(command: string): string {
  return `runuser -u agent -- env HOME=${AGENT_HOME} PATH=${HOMEBREW_NODE}:/usr/bin:/bin NPM_CONFIG_PREFIX=${NPM_PREFIX} ${command}`;
}
