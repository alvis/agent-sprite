// the paths and fixed values the Fly Machine boot script and its host-side
// wait share, derived from the guest constants the installer uses

import { GUEST_ROOT } from '#guest/guest-root';

/** where the volume is mounted */
export const VOLUME_PATH = '/data';
/** where the machine configuration's `files` field writes the boot script: the root filesystem, never the volume */
export const BOOT_SCRIPT_PATH = '/usr/local/sbin/open-agent-boot';
/** the boot script's mode: root's file, readable and runnable by every account */
export const BOOT_SCRIPT_MODE = 0o755;
/** the machine's init: the boot script, read by the shell so its mode never decides whether the machine boots */
export const BOOT_INIT: readonly string[] = ['/bin/sh', BOOT_SCRIPT_PATH];
/** this boot's state, on the root filesystem so a cold boot starts without it */
export const BOOT_RUN_DIRECTORY = '/run/open-agent';
/** written once the root filesystem is rebuilt: the boot's id, then `ok` or `failed` */
export const BOOT_READY_FILE = `${BOOT_RUN_DIRECTORY}/boot-ready`;
/** the kernel's id of the current boot, which the ready file must repeat */
export const BOOT_ID_FILE = '/proc/sys/kernel/random/boot_id';
/** every boot's step outcomes and durations, on the volume beside the other guest logs */
export const BOOT_LOG = `${GUEST_ROOT}/boot.log`;
/** the last boot's result and per-step durations as JSON, for doctor to summarize */
export const BOOT_STATUS = `${GUEST_ROOT}/boot-status.json`;
/** the steps every boot logs, in order */
export const BOOT_STEPS = [
  'volume',
  'guest-root',
  'agent-account',
  'homebrew-account',
  'apt-cache',
  'packages',
  'links',
  'profile',
  'label',
] as const;

/** the agent account's ids on a volume that holds no home for it yet */
export const AGENT_IDS = { uid: 1000, gid: 1000 } as const;
/** the Homebrew account's ids on a volume that holds no home for it yet; a system id */
export const HOMEBREW_IDS = { uid: 999, gid: 999 } as const;
/** the highest id Debian hands a system account */
export const SYSTEM_ID_MAX = 999;
/** the volume's directories, each bound over the root filesystem path it holds */
export const VOLUME_LAYOUT = {
  guestRoot: `${VOLUME_PATH}/open-agent`,
  homes: `${VOLUME_PATH}/home`,
  agentHome: `${VOLUME_PATH}/home/agent`,
  homebrewHome: `${VOLUME_PATH}/home/linuxbrew`,
  apt: `${VOLUME_PATH}/apt`,
  packages: `${VOLUME_PATH}/apt/packages`,
} as const;
/** the login profile that puts the managed tools on every login shell's PATH */
export const PROFILE_PATH = '/etc/profile.d/open-agent.sh';
/** apt's configuration that keeps downloads and records installed packages */
export const APT_CONFIGURATION = '/etc/apt/apt.conf.d/90open-agent';
/** the Debian image's apt hook, which deletes every downloaded package and would leave the volume's cache cold */
export const IMAGE_APT_CLEANER = '/etc/apt/apt.conf.d/docker-clean';
/** the guest-local Machines API socket, which only root reaches and which needs no token */
export const FLY_API_SOCKET = '/.fly/api';
/** how long a halted boot waits, for someone to read its log, before it stops the machine */
export const HALTED_WAIT_SECONDS = 600;
/** longest the halted boot's stop request may take */
export const STOP_REQUEST_SECONDS = 30;
/** how often a boot without a supervisor looks for one */
export const SUPERVISOR_POLL_SECONDS = 5;
/** the boot log's size beyond which it is trimmed */
export const LOG_LIMIT_BYTES = 524_288;
/** how much of the boot log a trim keeps */
export const LOG_KEPT_BYTES = 262_144;
/** packages the installer records that a supervised provider never uses: the guest supervisor's timer runs the schedule, not cron (REQ-MAINT-4), and cron-daemon-common serves cron alone */
export const UNUSED_PACKAGES = ['cron', 'cron-daemon-common'];
