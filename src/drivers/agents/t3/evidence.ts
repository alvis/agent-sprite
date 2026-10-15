import { runNativeProbe } from '#integrations/native/probe';
import { isRecord } from '#utilities/guards';

import { T3_PROBE_MODULE } from './guest-modules.js';

import type { GuestChannel } from '#drivers/guest-channel';

/** what the running T3 service reports at its unauthenticated environment endpoint */
export type T3Environment =
  | {
      ok: true;
      /** version the running T3 server reports */
      serverVersion: string;
      /** environment label the server reports, which is the workstation name once the guest names itself after it */
      label?: string;
      /** orchestration protocol revision the server reports, when it does */
      orchestrationProtocolVersion?: number;
    }
  | {
      ok: false;
      /** bounded reason the endpoint did not answer as expected */
      reason: string;
    };

/**
 * reads only the expected non-secret fields of the T3 environment endpoint
 * @param guest target guest
 * @returns validated environment evidence when the probe ran
 */
export async function inspectT3Environment(
  guest: GuestChannel,
): Promise<T3Environment | undefined> {
  const value = await runNativeProbe(guest, T3_PROBE_MODULE);
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.ok === true &&
    typeof value.serverVersion === 'string' &&
    value.serverVersion !== ''
  ) {
    return {
      ok: true,
      serverVersion: value.serverVersion,
      ...(typeof value.label === 'string' && value.label !== ''
        ? { label: value.label }
        : {}),
      ...(typeof value.orchestrationProtocolVersion === 'number'
        ? { orchestrationProtocolVersion: value.orchestrationProtocolVersion }
        : {}),
    };
  }
  if (value.ok === false && typeof value.reason === 'string') {
    return { ok: false, reason: value.reason };
  }

  return undefined;
}
