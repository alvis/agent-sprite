// every guest path the host and the guest programs share, defined once: the
// host imports them, and readAsset hands them to every guest program as
// OA_* variables

/** the one guest root every guest path derives from */
export const GUEST_ROOT = '/opt/open-agent';

/** where setup records the guest's environment */
export const ENVIRONMENT_PATH = `${GUEST_ROOT}/environment.json`;

/** home directory of the non-root account that runs the harnesses */
export const AGENT_HOME = '/home/agent';

/** where the agent's own commands, such as the npm-installed harnesses, live */
export const AGENT_BIN = `${AGENT_HOME}/.local/bin`;

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

/** the agent's PATH: its own commands, then Homebrew's ahead of the system's */
export const AGENT_PATH = `${AGENT_BIN}:${HOMEBREW_PATH}:/usr/local/bin:/usr/bin:/bin`;

/** the `PATH` every session command, and every root command outside a session, starts from, whatever the transport set: the system's commands first, then the tool links in `/usr/local` */
export const SESSION_PATH = `${SYSTEM_PATH}:/usr/local/sbin:/usr/local/bin`;

/**
 * root-only directory of the session lock, which the hourly update gate also
 * takes, and the process-group record
 */
export const SESSION_DIRECTORY = '/run/open-agent-session';
