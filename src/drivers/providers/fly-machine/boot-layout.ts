// the paths a Fly Machine's boot stub, its boot hook, its awake adapter and
// the host share, defined once: the host imports them, and the three guest
// programs receive them in their header as the OA_FLY_* variables

import { guestAsset } from '#integrations/guest/assets';
import {
  AGENT_HOME,
  GUEST_ROOT,
  LINUXBREW_HOME,
  LOGIN_PROFILE_PATH,
} from '#integrations/guest/layout';
import { ROOT_ONLY_MODE } from '#os/contracts';

import type { GuestAsset } from '#os/contracts';

/** where the volume is mounted */
export const VOLUME_PATH = '/data';
/** the volume's directories, each bound over the root filesystem path it holds, and the record of the packages to reinstall */
export const VOLUME_LAYOUT = {
  guestRoot: `${VOLUME_PATH}/open-agent`,
  homes: `${VOLUME_PATH}/home`,
  agentHome: `${VOLUME_PATH}${AGENT_HOME}`,
  homebrewHome: `${VOLUME_PATH}${LINUXBREW_HOME}`,
  apt: `${VOLUME_PATH}/apt`,
  packages: `${VOLUME_PATH}/apt/packages`,
} as const;

/** this boot's own state, which every boot starts without */
const BOOT_RUN = '/run/open-agent';
/** written once the boot is far enough for setup: the boot's id, then `ok`, `halted`, `resumed` or `failed` */
export const BOOT_READY_FILE = `${BOOT_RUN}/boot-ready`;
/** every boot's step outcomes and durations, on the volume beside the other guest logs */
export const BOOT_LOG = `${GUEST_ROOT}/boot.log`;
/** the last boot's result and per-step durations as JSON, for doctor to summarize */
export const BOOT_STATUS = `${GUEST_ROOT}/boot-status.json`;
/** the steps every run of the boot hook logs, in order */
export const BOOT_STEPS = [
  'secrets',
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
/** the root filesystem's own record: the image's packages and the restore marker */
const ROOTFS_STATE = '/var/lib/open-agent';
/** the marker the boot hook leaves on a root filesystem it restored; a rebuilt one lacks it, so the next boot reinstalls the recorded packages */
export const ROOTFS_RESTORED = `${ROOTFS_STATE}/rootfs-restored`;
/** the login profile that puts the managed tools on every login shell's PATH */
export const PROFILE_PATH = LOGIN_PROFILE_PATH;
/** the guest-local Machines API socket, which only root reaches */
const MACHINES_API = '/.fly/api';

/** the Fly paths the boot stub, the boot hook and the awake adapter receive in their header */
export const FLY_VARIABLES: Readonly<Record<string, string>> = {
  OA_FLY_VOLUME: VOLUME_PATH,
  OA_FLY_VOLUME_ROOT: VOLUME_LAYOUT.guestRoot,
  OA_FLY_VOLUME_HOMES: VOLUME_LAYOUT.homes,
  OA_FLY_VOLUME_AGENT_HOME: VOLUME_LAYOUT.agentHome,
  OA_FLY_VOLUME_HOMEBREW_HOME: VOLUME_LAYOUT.homebrewHome,
  OA_FLY_VOLUME_APT: VOLUME_LAYOUT.apt,
  OA_FLY_PACKAGES: VOLUME_LAYOUT.packages,
  OA_FLY_RUN: BOOT_RUN,
  OA_FLY_BOOT_READY: BOOT_READY_FILE,
  OA_FLY_BOOT_LOG: BOOT_LOG,
  OA_FLY_BOOT_STATUS: BOOT_STATUS,
  OA_FLY_ROOTFS_STATE: ROOTFS_STATE,
  OA_FLY_ROOTFS_RESTORED: ROOTFS_RESTORED,
  OA_FLY_PROFILE: PROFILE_PATH,
  OA_FLY_API: MACHINES_API,
};

/** the boot stub, which the machine configuration writes to the root filesystem; it is never installed under the guest root */
export const BOOT_STUB: Pick<GuestAsset, 'path' | 'variables'> = {
  path: 'drivers/providers/fly-machine/init.sh',
  variables: FLY_VARIABLES,
};
/** where the machine configuration's `files` field writes the boot stub */
export const BOOT_STUB_PATH = '/usr/local/sbin/open-agent-boot';
/** the boot stub's mode: root's file, readable and runnable by every account */
export const BOOT_STUB_MODE = 0o755;
/** the boot hook, kept on the volume, which the stub runs on every boot, and setup to prepare the guest, to restore what a host move's rebuilt root filesystem lost */
export const BOOT_HOOK: GuestAsset = guestAsset(
  'drivers/providers/fly-machine/boot.sh',
  ROOT_ONLY_MODE,
  FLY_VARIABLES,
);
/** the boot hook's path on the volume, where the stub looks for it before the guest root is bound */
export const BOOT_HOOK_ON_VOLUME = `${VOLUME_LAYOUT.guestRoot}/${BOOT_HOOK.path}`;
/** how long a stop gives the boot stub before Fly kills the machine; the stub waits at most 20 seconds of it for runit's services */
export const BOOT_STOP_SECONDS = 30;
/** the machine's init: the stub, read by the shell so its mode never decides whether the machine boots, given the hook to run */
export const BOOT_INIT: readonly string[] = [
  '/bin/sh',
  BOOT_STUB_PATH,
  BOOT_HOOK_ON_VOLUME,
];
