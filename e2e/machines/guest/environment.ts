import { parseEnvironment } from '#adapters/guest/environment/contracts';
import { ENVIRONMENT_PATH } from '#adapters/guest/platform/layout';
import { registry } from '#composition/registry';

import type { GuestEnvironment } from '#domain/observations/environment';

import type { MachineProvider } from '../providers';

/**
 * reads the record setup leaves on the guest, straight from the guest
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the validated record
 */
export async function readEnvironment(
  provider: MachineProvider,
  name: string,
): Promise<GuestEnvironment> {
  return parseEnvironment(
    registry,
    await provider.execute(name, `cat ${ENVIRONMENT_PATH}`),
  );
}
