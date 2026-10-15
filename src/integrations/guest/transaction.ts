import { AsyncLocalStorage } from 'node:async_hooks';

import { ensureError, retainRecoveryFailure } from '#errors';
import { checkOperation, recoverOperation } from '#operation';

import { GuestTransaction } from './transaction/client.js';

import type { GuestChannel } from '#drivers/guest-channel';

const scope = new AsyncLocalStorage<
  ReadonlyMap<GuestChannel, GuestTransaction>
>();

/**
 * reuses exact-channel ownership or opens one continuous guest filesystem transaction
 * @param guest target guest, identified by its exact channel object
 * @param action host decisions whose protected IO executes through the guest worker
 * @param bootstrap whether missing managed Node may be installed under the lock
 * @returns protected action result after acknowledged guest release
 */
export async function withGuestTransaction<T>(
  guest: GuestChannel,
  action: () => Promise<T>,
  bootstrap = false,
): Promise<T> {
  checkOperation();
  const existing = currentGuestTransaction(guest);
  if (existing) {
    existing.check();

    return action();
  }
  const transaction = await GuestTransaction.open(guest, bootstrap);
  const transactions = new Map(scope.getStore());
  transactions.set(guest, transaction);
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
 * @param guest exact target channel
 * @returns active or stopping owner for the target
 */
export function currentGuestTransaction(
  guest: GuestChannel,
): GuestTransaction | undefined {
  return scope.getStore()?.get(guest);
}

/**
 * starts official provider service IO only while the surrounding transaction is healthy
 * @param guest exact target guest
 * @param request official SDK service request in its separate acknowledgement domain
 * @returns provider request outcome without claiming filesystem settlement
 */
export async function guestServiceRequest<T>(
  guest: GuestChannel,
  request: () => Promise<T>,
): Promise<T> {
  currentGuestTransaction(guest)?.check();

  return request();
}
