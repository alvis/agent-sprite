import { projectFields, same } from './fields';

import type { PairingData } from '#application/data';
import type { PairingSecret } from '#kernel/pairing-secret';

/** pairing outcome; the token stays a secret until the serializer discloses it */
export interface PairingOutput {
  status: string;
  expiresAt?: string;
  token?: PairingSecret;
  reason?: string;
  retry?: string;
}

/**
 * projects pairing metadata, passing the secret through untouched
 * @param pairing internal pairing outcome
 * @returns output pairing outcome
 */
export function projectPairing(pairing: PairingData): PairingOutput {
  return projectFields<PairingData, PairingOutput>(pairing, {
    status: same,
    expiresAt: same,
    token: same,
    reason: same,
    retry: same,
  });
}
