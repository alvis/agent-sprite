import { describe, expect, it, vi } from 'vitest';

import { resolveEnrollmentKey } from '#application/input/management';
import { revealSecret } from '#kernel/secret';

import type { NetworkDriver } from '#application/ports/drivers';

const network = {
  displayName: 'Private network',
  issueCredential: vi.fn<NetworkDriver['issueCredential']>(
    async () => 'issued-key',
  ),
} satisfies Pick<NetworkDriver, 'displayName' | 'issueCredential'>;

describe('fn:resolveEnrollmentKey', () => {
  it('should preserve an explicitly supplied enrollment key', async () => {
    const key = await resolveEnrollmentKey(network, {
      enrollmentKey: 'supplied-key',
    });

    expect(revealSecret(key)).toBe('supplied-key');
  });

  it('should refuse enrollment without a key or management account', async () => {
    await expect(resolveEnrollmentKey(network, {})).rejects.toMatchObject({
      code: 'INPUT',
    });
  });
});
