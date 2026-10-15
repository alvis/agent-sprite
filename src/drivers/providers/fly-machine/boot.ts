import { setTimeout as delay } from 'node:timers/promises';

import { ProviderFault } from '#drivers/failures';

import { BOOT_ID_FILE, BOOT_LOG, BOOT_READY_FILE } from './guest/boot-paths.js';

import type { FlyApi, FlyMachineTarget } from './api.js';

/** what the ready file says about the current boot */
type BootState = 'pending' | 'ok' | 'failed';

/** a boot restores accounts and packages from the volume within seconds; the first create's apt work is the slowest */
const BOOT_WAIT_MS = 180_000;
const BOOT_POLL_MS = 1_000;
const MILLISECONDS_PER_SECOND = 1_000;
const BOOT_PROBE_SECONDS = 10;

/**
 * waits until the boot script has rebuilt the root filesystem in the
 * machine's current boot, so nothing reaches the guest before its accounts,
 * bind mounts and packages are back
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
    if (state === 'ok') {
      return;
    }
    if (state === 'failed') {
      throw new ProviderFault({
        code: 'failed',
        message: `The Fly Machine ${target.machine} failed to restore its root filesystem from the volume; see ${BOOT_LOG} on the machine, or fly logs when the volume is not mounted`,
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
      ['/bin/cat', BOOT_READY_FILE, BOOT_ID_FILE],
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

    return status === 'ok' ? 'ok' : 'failed';
  } catch (exception) {
    if ((exception as ProviderFault).code === 'authentication') {
      throw exception;
    }

    return 'pending';
  }
}
