// every guest path and value the host and the guest programs share, defined
// once: the host imports them, and readAsset hands them to every guest
// program as OA_* variables

/** where the non-root accounts' homes are */
const HOMES = '/home';

/**
 * locates a non-root account's home
 * @param user account name
 * @returns the account's home directory
 */
export function accountHome(user: string): string {
  return `${HOMES}/${user}`;
}

/** the one guest root every guest path derives from */
export const GUEST_ROOT = '/opt/open-agent';

/** where setup records the guest's environment */
export const ENVIRONMENT_PATH = `${GUEST_ROOT}/environment.json`;

/** home directory of the non-root account that runs the harnesses */
export const AGENT_HOME = accountHome('agent');

/**
 * the agent account's user and group id, the one the Fly boot hook restores
 * too; it stays clear of 1000, the first user an image adds, such as the
 * `ubuntu` account of the Sprite image
 */
export const AGENT_ID = '2000';

/** where the agent's own commands, such as the npm-installed harnesses, live */
export const AGENT_BIN = `${AGENT_HOME}/.local/bin`;

/** the agent's private open-agent configuration directory */
export const AGENT_CONFIG = `${AGENT_HOME}/.config/open-agent`;

/** the runtime environment the agent keeps for its applications */
export const RUNTIME_ENV_PATH = `${AGENT_CONFIG}/runtime-env.json`;

/** the committer the agent configured */
export const COMMITTER_PATH = `${AGENT_CONFIG}/committer.json`;

/** home of the system account that owns the Homebrew prefix */
export const LINUXBREW_HOME = accountHome('linuxbrew');

/** the default Homebrew prefix, the only one bottles pour at */
export const HOMEBREW_PREFIX = `${LINUXBREW_HOME}/.linuxbrew`;

/** where the tool links are made, which every PATH searches after the system's own directories */
export const TOOL_LINKS = '/usr/local/bin';

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

/** the tail every non-root account's PATH ends with: the tool links, then the system's commands */
export const ACCOUNT_BASE_PATH = `${TOOL_LINKS}:/usr/bin:/bin`;

/** a non-root account's PATH: Homebrew's commands ahead of the base */
export const ACCOUNT_PATH = `${HOMEBREW_PATH}:${ACCOUNT_BASE_PATH}`;

/** the agent's PATH: its own commands, then the account PATH */
export const AGENT_PATH = `${AGENT_BIN}:${ACCOUNT_PATH}`;

/** the `PATH` every session command, and every root command outside a session, starts from, whatever the transport set: the system's commands first, then the tool links in `/usr/local` */
export const SESSION_PATH = `${SYSTEM_PATH}:/usr/local/sbin:${TOOL_LINKS}`;

/** the login profile every login shell reads, which puts the managed tools on its PATH */
export const LOGIN_PROFILE_PATH = '/etc/profile.d/open-agent.sh';

/**
 * the login profile's text: root's PATH puts the system's commands ahead of
 * the tool links, and an ordinary account's its own commands, then
 * Homebrew's, ahead of the system's; the Fly boot hook writes the same text
 */
export const LOGIN_PROFILE = [
  "# open-agent: the system's commands ahead of the tool links for root; its own",
  "# commands, then Homebrew's, ahead of the system's for an ordinary account",
  'if test "$(id -u)" = 0; then',
  `  PATH="${SESSION_PATH}"`,
  'else',
  `  PATH="$HOME/.local/bin:${ACCOUNT_PATH}"`,
  'fi',
  "# nano, which every workstation installs, is every account's editor",
  'EDITOR=nano',
  'VISUAL=nano',
  'export PATH EDITOR VISUAL',
  '',
].join('\n');

/**
 * root-only directory of the session lock, which the hourly update gate also
 * takes, and the process-group record
 */
export const SESSION_DIRECTORY = '/run/open-agent-session';

/** the lock a setup session holds while it runs, which the boot, the update gate and the network launcher wait on or test */
export const SESSION_LOCK = `${SESSION_DIRECTORY}/session.lock`;

/**
 * the memory-backed directory the runit backend keeps each service's runtime
 * state in: a root-owned start marker per service, and a private directory
 * owned by the service's account, which holds what the service captured of its
 * own stderr for the service's finish hook to read; it never lives on the volume
 */
export const SERVICE_STATE_DIRECTORY = '/run/open-agent-service';

/** the memory-backed directory setup delivers its secrets in */
export const SECRET_DIRECTORY = '/dev/shm';

/** the prefix of every directory a setup secret is delivered in, which a crash sweep removes */
export const SECRET_PREFIX = `${SECRET_DIRECTORY}/open-agent.`;

/** the kernel's id of the current boot */
export const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';

/** the file whose `PRETTY_HOSTNAME` the agent reads as the human-readable name of the environment it runs in */
export const MACHINE_INFO_PATH = '/etc/machine-info';

/** the key of the machine information file that holds the human-readable host name */
export const MACHINE_INFO_LABEL_KEY = 'PRETTY_HOSTNAME';

/** root-owned record of the workstation name on the persistent guest root, from which a provider that rebuilds its root filesystem on boot restores the machine information file */
export const WORKSTATION_NAME_PATH = `${GUEST_ROOT}/workstation-name`;

/** where the updater records its last run, which every account reads */
export const UPDATE_STATUS_PATH = `${GUEST_ROOT}/update-status.json`;

/** where the update gate keeps every run's output */
export const UPDATE_LOG = `${GUEST_ROOT}/update.log`;

/** the group range that lets every account open an unprivileged ping socket */
export const PING_GROUP_RANGE = '0 2147483647';
