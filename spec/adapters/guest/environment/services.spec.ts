import { describe, expect, it } from 'vitest';

import { environmentNetwork } from '#adapters/guest/environment/services';
import { registry } from '#composition/registry';

import type { NetworkDriver } from '#application/ports/drivers';

describe('fn:environmentNetwork', () => {
  it.each([
    { id: 'tailscale', daemon: registry.networks.tailscale.daemon },
    { id: 'tailscale', launcher: registry.networks.tailscale.launcher },
  ] satisfies Array<Pick<NetworkDriver, 'id' | 'daemon' | 'launcher'>>)(
    'should reject a daemon and launcher that are not declared together: %j',
    (network) => {
      expect(() => environmentNetwork(network)).toThrow(
        expect.objectContaining({
          message: expect.stringMatching(/daemon without its launcher/u),
        }),
      );
    },
  );
});
