import { setTimeout as delay } from 'node:timers/promises';

import { ProviderFault } from '#drivers/failures';
import { BOOT_ID_PATH } from '#integrations/guest/layout';
import { runGuest } from '#integrations/guest/run';
import { isRecord } from '#utilities/guards';

import { BOOT_LOG, BOOT_READY_FILE, BOOT_STATUS } from './boot-layout';

import type { BootReport } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

import type { FlyApi, FlyMachineTarget } from './api';
import type { FlyMachine } from './wire';

/**
 * what the ready file says about the current boot: `halted` is a boot a
 * critical step stopped with the guest root on the volume, which setup
 * repairs; `failed` one whose volume or guest root is unusable
 */
type BootState = 'pending' | 'ok' | 'halted' | 'failed';

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
