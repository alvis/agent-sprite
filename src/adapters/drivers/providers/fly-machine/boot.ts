import { setTimeout as delay } from 'node:timers/promises';

import { guestAsset, readAsset } from '#adapters/guest/platform/assets';
import {
  AGENT_HOME,
  BOOT_ID_PATH,
  GUEST_ROOT,
  LINUXBREW_HOME,
  LOGIN_PROFILE_PATH,
} from '#adapters/guest/platform/layout';
import { runGuest } from '#adapters/guest/platform/run';
import { ROOT_ONLY_MODE } from '#domain/guest';
import { isRecord } from '#kernel/guards';
import { ProviderFault } from '#kernel/provider-fault';

import type { GuestChannel } from '#application/ports/guest-channel';
import type { SetupStep, StepCommand } from '#application/ports/plan';
import type { GuestAsset } from '#domain/guest';
import type { BootReport } from '#domain/observations/boot';

import type { FlyApi, FlyMachineTarget } from './api';
import type { FlyMachine } from './wire';

/**
 * what the ready file says about the current boot: `halted` is a boot a
 * critical step stopped with the guest root on the volume, which setup
 * repairs; `failed` one whose volume or guest root is unusable
 */
type BootState = 'pending' | 'ok' | 'halted' | 'failed';

/** what the boot hook step is built with */
interface BootHookStepParams {
  /** the boot hook's text, as read from the package */
  hook: string;
  /** ids of steps the boot hook step needs, such as the one installing the guest libraries it calls */
  needs?: readonly string[];
}

/** a boot restores accounts and packages from the volume within seconds; the first create's apt work is the slowest */
const BOOT_WAIT_MS = 180_000;

const BOOT_POLL_MS = 1_000;

const MILLISECONDS_PER_SECOND = 1_000;

const BOOT_PROBE_SECONDS = 10;

const START_WAIT_SECONDS = 60;

/** the current boot's state by the ready file's word; a boot a prepare resumed runs again through to runsvdir, and any other word is a failure */
const READY_STATES: ReadonlyMap<string, BootState> = new Map([
  ['ok', 'ok'],
  ['resumed', 'ok'],
  ['halted', 'halted'],
]);

/** the prefix of every line the boot hook logs itself, as opposed to a step's own output */
const LOG_PREFIX = 'open-agent-boot ';

/** how many of the boot hook's latest lines the report keeps */
const LOG_LINES = 20;

/** the line separating the status from the log lines in the probe's output */
const SEPARATOR = '--- open-agent boot log ---';

/** longest the probe may take, short enough for the REST exec endpoint */
const REPORT_TIMEOUT_MS = 30_000;

/**
 * prints boot-status.json, the separator, then the hook's latest own lines
 * of boot.log; either file may be missing before the first boot recorded it
 */
const REPORT_PROBE = [
  'cat "$1" 2>/dev/null',
  'printf "\\n%s\\n" "$3"',
  `grep -F -- "$4" "$2" 2>/dev/null | tail -n ${String(LOG_LINES)}`,
  'exit 0',
].join('\n');

// the paths a Fly Machine's boot stub, its boot hook, its awake adapter and
// the host share, defined once: the host imports them, and the three guest
// programs receive them in their header as the OA_FLY_* variables

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

/** id of the step that installs the boot hook on the volume and prepares the guest with it */
const BOOT_HOOK_STEP = 'boot-hook';

/** the radix chmod reads a mode in */
const OCTAL = 8;
/** longest one command of the step may take: a prepare after a rebuilt root filesystem reinstalls the recorded packages */
const BOOT_HOOK_LIMIT_MS = 900_000;

/**
 * the shell program that tells whether the hook on the volume is the one on
 * its input and a prepare would change nothing; its one argument is the hook
 */
const CHECK_PROGRAM = 'cmp -s - "$1" && /bin/sh "$1" check';

/**
 * the shell program that writes the hook on its input to the volume, root's
 * alone as the boot stub demands, then runs its prepare; its arguments are
 * the hook and its mode
 */
const INSTALL_PROGRAM = [
  'umask 022',
  'install -d -m 0755 "$(dirname "$1")"',
  'cat >"$1.new"',
  'chmod "$2" "$1.new"',
  'mv -f "$1.new" "$1"',
  '/bin/sh "$1" prepare',
].join(' && ');

/**
 * builds the boot hook step from the hook the package ships, so a rebuilt
 * root filesystem is restored on boot
 * @param needs ids of the steps installing the libraries the hook sources
 * @returns a step that installs the hook and runs it once
 */
export async function flyBootHookStep(
  needs: readonly string[],
): Promise<SetupStep> {
  return bootHookStep({ hook: await readAsset(BOOT_HOOK), needs });
}

/**
 * starts a stopped or suspended machine, then waits for its boot script; a
 * machine already starting, or one whose start conflicts with a start under
 * way, is only waited for
 * @param api Machines API client
 * @param target app and machine
 * @param machine the machine as last observed
 */
export async function startAndBoot(
  api: FlyApi,
  target: FlyMachineTarget,
  machine: Pick<FlyMachine, 'state'>,
): Promise<void> {
  if (machine.state !== 'started') {
    if (machine.state !== 'starting') {
      await api.startMachine(target).catch((error: unknown) => {
        if (!(error instanceof ProviderFault && error.code === 'conflict')) {
          throw error;
        }
      });
    }
    await api.waitUntilStarted(target, START_WAIT_SECONDS);
  }
  await waitForBoot(api, target);
}

/**
 * waits until the boot script has rebuilt the root filesystem in the
 * machine's current boot, so nothing reaches the guest before its accounts,
 * bind mounts and packages are back; a halted boot is reachable too, so
 * doctor can report it and setup's boot hook step can repair it before the
 * boot stub stops the machine
 * @param api Machines API client
 * @param target app and machine
 */
export async function waitForBoot(
  api: FlyApi,
  target: FlyMachineTarget,
): Promise<void> {
  const deadline = Date.now() + BOOT_WAIT_MS;
  for (;;) {
    const state = await readBootState(api, target);
    if (state === 'ok' || state === 'halted') {
      return;
    }
    if (state === 'failed') {
      throw new ProviderFault({
        code: 'failed',
        message: `The Fly Machine ${target.machine} could not bind its volume's guest root; see fly logs`,
      });
    }
    if (Date.now() >= deadline) {
      throw new ProviderFault({
        code: 'transient',
        message: `The Fly Machine ${target.machine} did not finish its boot script within ${BOOT_WAIT_MS / MILLISECONDS_PER_SECOND} seconds`,
      });
    }
    await delay(BOOT_POLL_MS);
  }
}

/**
 * reads the ready file beside the kernel's boot id; a file left by an
 * earlier boot, or a machine not yet answering exec, is still pending
 * @param api Machines API client
 * @param target app and machine
 * @returns the current boot's state
 */
async function readBootState(
  api: FlyApi,
  target: FlyMachineTarget,
): Promise<BootState> {
  try {
    const result = await api.exec(
      target,
      ['/bin/cat', BOOT_READY_FILE, BOOT_ID_PATH],
      BOOT_PROBE_SECONDS,
    );
    if ((result.exitCode ?? 0) !== 0) {
      return 'pending';
    }
    const [ready = '', bootId = ''] = result.stdout.trim().split('\n');
    const [readyId, status] = ready.trim().split(' ');
    if (readyId !== bootId.trim()) {
      return 'pending';
    }

    return READY_STATES.get(status ?? '') ?? 'failed';
  } catch (exception) {
    if ((exception as ProviderFault).code === 'authentication') {
      throw exception;
    }

    return 'pending';
  }
}

/**
 * reads the last boot's result and the boot hook's latest log lines in one
 * guest command; the log keeps only the hook's own lines, never a step's
 * output, which may quote the guest's files
 * @param guest guest channel of the machine
 * @returns the last boot's result, its unsuccessful steps and its latest log lines
 */
export async function inspectFlyBoot(guest: GuestChannel): Promise<BootReport> {
  const { stdout } = await runGuest(
    guest,
    [
      '/bin/sh',
      '-c',
      REPORT_PROBE,
      'oa-boot',
      BOOT_STATUS,
      BOOT_LOG,
      SEPARATOR,
      LOG_PREFIX,
    ],
    { timeoutMs: REPORT_TIMEOUT_MS, step: 'boot record read' },
  );
  const separator = stdout.lastIndexOf(`\n${SEPARATOR}\n`);
  const status = separator < 0 ? '' : stdout.slice(0, separator);
  const log =
    separator < 0 ? '' : stdout.slice(separator + SEPARATOR.length + 2);

  return {
    ...parseBootStatus(status),
    log: log
      .split('\n')
      .filter((line) => line.startsWith(LOG_PREFIX))
      .map((line) => line.slice(LOG_PREFIX.length)),
  };
}

/**
 * reads the result and the unsuccessful steps out of boot-status.json
 * @param text the file's contents; empty before a boot recorded them
 * @returns the recorded result, nothing when the file is absent or malformed
 */
function parseBootStatus(text: string): Omit<BootReport, 'log'> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (!isRecord(value)) {
    return { unsuccessfulSteps: {} };
  }
  const steps = isRecord(value.steps) ? value.steps : {};

  return {
    ...(value.status === 'ok' ||
    value.status === 'failed' ||
    value.status === 'halted'
      ? { status: value.status }
      : {}),
    ...(typeof value.startedAt === 'string'
      ? { startedAt: value.startedAt }
      : {}),
    ...(typeof value.durationMs === 'number'
      ? { durationMs: value.durationMs }
      : {}),
    unsuccessfulSteps: Object.fromEntries(
      Object.entries(steps).flatMap(([name, step]) =>
        isRecord(step) &&
        typeof step.outcome === 'string' &&
        step.outcome !== 'ok'
          ? [[name, step.outcome]]
          : [],
      ),
    ),
  };
}

/**
 * builds the step that installs the boot hook on the volume, where the boot
 * stub runs it on every boot, and runs its prepare: it binds the volume's
 * directories, recreates the accounts and points apt's cache at the volume
 * before any later step installs a package
 * @param params the hook's text and the steps it needs
 * @returns a critical root step whose check and verify ask whether the hook is current and the guest prepared
 */
function bootHookStep(params: BootHookStepParams): SetupStep {
  const { hook, needs = [] } = params;
  const input = { kind: 'text', value: hook } as const;
  const check: StepCommand = {
    argv: ['/bin/sh', '-c', CHECK_PROGRAM, 'oa-boot-hook', BOOT_HOOK_ON_VOLUME],
    input,
  };

  return {
    id: BOOT_HOOK_STEP,
    component: 'boot-hook',
    account: 'root',
    needs,
    check,
    apply: {
      argv: [
        '/bin/sh',
        '-c',
        INSTALL_PROGRAM,
        'oa-boot-hook',
        BOOT_HOOK_ON_VOLUME,
        BOOT_HOOK.mode.toString(OCTAL),
      ],
      input,
    },
    verify: check,
    timeoutMs: BOOT_HOOK_LIMIT_MS,
    critical: true,
    retry: 'transport',
  };
}
