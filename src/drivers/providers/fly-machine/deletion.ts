import { setTimeout as delay } from 'node:timers/promises';

import { ProviderFault } from '#drivers/failures';
import { runOperation } from '#operation';

import type { FlyApi } from './api.js';

const DELETE_TIMEOUT_MS = 120_000;
const DELETE_POLL_MS = 2_000;
const MILLISECONDS_PER_SECOND = 1_000;

/**
 * waits until a deleted app is no longer listed
 * @param api Machines API client
 * @param name app name
 * @throws {ProviderFault} transient when the app is still present after the deadline
 */
export async function waitUntilDeleted(
  api: FlyApi,
  name: string,
): Promise<void> {
  const deadline = Date.now() + DELETE_TIMEOUT_MS;
  while (await stillPresent(api, name)) {
    if (Date.now() >= deadline) {
      throw new ProviderFault({
        code: 'transient',
        message: `Fly app ${name} was still present ${DELETE_TIMEOUT_MS / MILLISECONDS_PER_SECOND} s after deletion`,
      });
    }
    await runOperation(async () => delay(DELETE_POLL_MS));
  }
}

/**
 * tells whether a deleted app is still listed; a transient failure leaves
 * the answer open, so the polling continues until its deadline
 * @param api Machines API client
 * @param name app name
 * @returns false once the app is gone
 */
async function stillPresent(api: FlyApi, name: string): Promise<boolean> {
  return api.hasApp(name).catch((error: unknown) => {
    if (error instanceof ProviderFault && error.code === 'transient') {
      return true;
    }
    throw error;
  });
}
