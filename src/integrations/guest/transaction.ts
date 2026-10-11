import { AsyncLocalStorage } from 'node:async_hooks';

import { ensureError, retainRecoveryFailure } from '#errors';
import { checkOperation, recoverOperation } from '#operation';

import { GuestTransaction } from './transaction/client.js';

import type { Sprite } from '@fly/sprites';

const scope = new AsyncLocalStorage<ReadonlyMap<Sprite, GuestTransaction>>();

/**
 * reuses exact-Sprite ownership or opens one continuous guest filesystem transaction
 * @param sprite target guest, identified by its exact SDK object
 * @param action host decisions whose protected IO executes through the guest worker
 * @param bootstrap whether missing managed Node may be installed under the lock
 * @returns protected action result after acknowledged guest release
 */
export async function withGuestTransaction<T>(
  sprite: Sprite,
  action: () => Promise<T>,
  bootstrap = false,
): Promise<T> {
  checkOperation();
  const existing = currentGuestTransaction(sprite);
  if (existing) {
    existing.check();

    return action();
  }
  const transaction = await GuestTransaction.open(sprite, bootstrap);
  const transactions = new Map(scope.getStore());
  transactions.set(sprite, transaction);
  const [outcome] = await Promise.allSettled([
    scope.run(transactions, async () => action()),
  ]);
  try {
    await recoverOperation(async () => transaction.finish());
  } catch (releaseError) {
    if (outcome.status === 'rejected') {
      throw retainRecoveryFailure(
        ensureError(outcome.reason),
        'guest transaction release',
        releaseError,
      );
    }
    throw releaseError;
  }
  if (outcome.status === 'rejected') {
    throw outcome.reason;
  }

  return outcome.value;
}

/**
 * obtains only ownership inherited by the current host callback
 * @param sprite exact target SDK instance
 * @returns active or stopping owner for the target
 */
export function currentGuestTransaction(
  sprite: Sprite,
): GuestTransaction | undefined {
  return scope.getStore()?.get(sprite);
}

/**
 * starts official provider service IO only while the surrounding transaction is healthy
 * @param sprite exact target guest
 * @param request official SDK service request in its separate acknowledgement domain
 * @returns provider request outcome without claiming filesystem settlement
 */
export async function guestServiceRequest<T>(
  sprite: Sprite,
  request: () => Promise<T>,
): Promise<T> {
  currentGuestTransaction(sprite)?.check();

  return request();
}
