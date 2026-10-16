import type { ProviderDriver } from '#drivers/contracts';

import type { ProviderId } from './catalog';

/** a provider bound to its management credential */
export interface BoundProvider {
  /** provider identifier */
  id: ProviderId;
  /** provider bound to a credential */
  driver: ProviderDriver;
}

/** which providers hold a workstation, and which could not be asked */
interface ProviderHolders {
  /** providers that hold the named workstation, or any workstation when none is named */
  holders: ProviderId[];
  /** failures of providers that could not be asked, other than not finding the name */
  failures: unknown[];
}

/**
 * asks every bound provider, without waking a workstation, whether it holds
 * the named workstation, or holds any when no name is given
 * @param providers providers bound to their credentials
 * @param machine exact workstation name, if one was given
 * @returns the providers that hold it and the failures of those that could not say
 */
export async function providersHolding(
  providers: readonly BoundProvider[],
  machine?: string,
): Promise<ProviderHolders> {
  const answers = await Promise.all(
    providers.map(async ({ id, driver }) => {
      try {
        return {
          id,
          isHolder: machine
            ? Boolean(await driver.get(machine))
            : (await driver.list()).length > 0,
        };
      } catch (error) {
        return (error as { code?: unknown }).code === 'not-found'
          ? { id, isHolder: false }
          : { id, failure: error };
      }
    }),
  );

  return {
    holders: answers.flatMap((answer) =>
      'isHolder' in answer && answer.isHolder ? [answer.id] : [],
    ),
    failures: answers.flatMap((answer) =>
      'failure' in answer ? [answer.failure] : [],
    ),
  };
}
