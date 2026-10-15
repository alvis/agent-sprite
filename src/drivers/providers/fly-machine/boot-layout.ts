// the paths a Fly Machine's boot stub, its boot hook and the host share; the
// two guest programs repeat them, since sh cannot import them

import { guestAsset } from '#guest/assets';
import { GUEST_ROOT } from '#guest/guest-root';
import { ROOT_ONLY_MODE } from '#os/contracts';

import type { GuestAsset } from '#os/contracts';

/** where the volume is mounted */
export const VOLUME_PATH = '/data';
/** the volume's directories, each bound over the root filesystem path it holds, and the record of the packages to reinstall */
export const VOLUME_LAYOUT = {
  guestRoot: `${VOLUME_PATH}/open-agent`,
  homes: `${VOLUME_PATH}/home`,
  agentHome: `${VOLUME_PATH}/home/agent`,
  homebrewHome: `${VOLUME_PATH}/home/linuxbrew`,
  apt: `${VOLUME_PATH}/apt`,
  packages: `${VOLUME_PATH}/apt/packages`,
} as const;

/** the boot stub, which the machine configuration writes to the root filesystem; it is never installed under the guest root */
export const BOOT_STUB: Pick<GuestAsset, 'path'> = {
  path: 'drivers/providers/fly-machine/guest/boot-stub.sh',
};
/** where the machine configuration's `files` field writes the boot stub */
export const BOOT_STUB_PATH = '/usr/local/sbin/open-agent-boot';
/** the boot stub's mode: root's file, readable and runnable by every account */
export const BOOT_STUB_MODE = 0o755;
/** the boot hook, kept on the volume, which the stub runs on every boot, and setup to prepare the guest, to restore what a host move's rebuilt root filesystem lost */
export const BOOT_HOOK: GuestAsset = guestAsset(
  'drivers/providers/fly-machine/guest/boot.sh',
  ROOT_ONLY_MODE,
);
/** the boot hook's path on the volume, where the stub looks for it before the guest root is bound */
export const BOOT_HOOK_ON_VOLUME = `${VOLUME_LAYOUT.guestRoot}/${BOOT_HOOK.path}`;
/** the machine's init: the stub, read by the shell so its mode never decides whether the machine boots, given the hook to run */
export const BOOT_INIT: readonly string[] = [
  '/bin/sh',
  BOOT_STUB_PATH,
  BOOT_HOOK_ON_VOLUME,
];

/** written once the boot is far enough for setup: the boot's id, then `ok` or `failed` */
export const BOOT_READY_FILE = '/run/open-agent/boot-ready';
/** the kernel's id of the current boot, which the ready file must repeat */
export const BOOT_ID_FILE = '/proc/sys/kernel/random/boot_id';
/** every boot's step outcomes and durations, on the volume beside the other guest logs */
export const BOOT_LOG = `${GUEST_ROOT}/boot.log`;
/** the last boot's result and per-step durations as JSON, for doctor to summarize */
export const BOOT_STATUS = `${GUEST_ROOT}/boot-status.json`;
/** the steps every run of the boot hook logs, in order */
export const BOOT_STEPS = [
  'volume',
  'guest-root',
  'libraries',
  'agent-account',
  'homebrew-account',
  'apt-cache',
  'packages',
  'links',
  'services',
  'profile',
  'label',
  'ping',
] as const;
/** the marker the boot hook leaves on a root filesystem it restored; a rebuilt one lacks it, so the next boot reinstalls the recorded packages */
export const ROOTFS_RESTORED = '/var/lib/open-agent/rootfs-restored';
/** the login profile that puts the managed tools on every login shell's PATH */
export const PROFILE_PATH = '/etc/profile.d/open-agent.sh';
