import { describe, expect, it } from 'vitest';

import { FLY_MACHINE_AWAKE } from '#adapters/drivers/providers/fly-machine/capabilities';
import { guestAsset, readAsset } from '#adapters/guest/platform/assets';

describe('fn:readAsset', () => {
  it('should reject a guest asset that escapes the package tree', () => {
    expect(() => guestAsset('../outside.sh', 0o755)).toThrow(/relative/iu);
  });

  it('should assign the variables an asset adds after the layout in its header', async () => {
    const awake = await readAsset(FLY_MACHINE_AWAKE);
    const plain = await readAsset({
      path: 'drivers/providers/sprite/awake.sh',
    });

    expect(awake).toContain("\nOA_GUEST_ROOT='/opt/open-agent'\n");
    expect(awake).toContain("\nOA_FLY_API='/.fly/api'\n");
    expect(plain).toContain("\nOA_GUEST_ROOT='/opt/open-agent'\n");
    expect(plain).not.toContain('OA_FLY_API=');
  });

  it('should refuse an added variable that is not an OA_ name or redefines the layout', async () => {
    await expect(
      readAsset({
        path: 'drivers/providers/sprite/awake.sh',
        variables: { OA_GUEST_ROOT: '/srv', PATH: '/srv/bin' },
      }),
    ).rejects.toThrow(
      'Guest asset drivers/providers/sprite/awake.sh adds invalid header variables: OA_GUEST_ROOT, PATH',
    );
  });
});
