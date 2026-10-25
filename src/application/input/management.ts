import { CommandFault } from '#kernel/faults';
import { Secret } from '#kernel/secret';

import type {
  NetworkDriver,
  NetworkManagement,
} from '#application/ports/drivers';

import type { ResolvedInputs } from './types';

/**
 * gathers the caller-side network management credential from resolved inputs
 * @param input resolved inputs
 * @returns the credential with its account when known, or undefined without a key
 */
export function networkManagement(
  input: Pick<ResolvedInputs, 'networkKey' | 'networkAccount'>,
): NetworkManagement | undefined {
  return input.networkKey
    ? { credential: input.networkKey, account: input.networkAccount }
    : undefined;
}

/**
 * selects the supplied enrolment key or mints one short-lived single-use key
 * @param network selected network
 * @param input resolved caller-side network credentials and account
 * @returns a transient key for one new device, delivered as setup session input
 */
export async function resolveEnrollmentKey(
  network: Pick<NetworkDriver, 'displayName' | 'issueCredential'>,
  input: Pick<
    ResolvedInputs,
    'enrollmentKey' | 'networkKey' | 'networkAccount'
  >,
): Promise<Secret> {
  if (input.enrollmentKey) {
    return Secret.fromHost('credential-file', input.enrollmentKey);
  }
  const management = networkManagement(input);
  const key = management?.account
    ? await network.issueCredential(management)
    : undefined;
  if (!key) {
    throw new CommandFault({
      code: 'INPUT',
      message: `${network.displayName} enrolment requires an auth key or management API key`,
    });
  }

  return Secret.fromHost('provider-api', key);
}
