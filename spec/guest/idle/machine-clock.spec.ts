import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readMachineClock } from '#guest/idle/machine-clock';

import { createIdleRoot } from '../../fixtures/idle-root';

describe('fn:readMachineClock', () => {
  it('should read the boot id and the uptime in milliseconds', async () => {
    await using idle = await createIdleRoot(0);
    await mkdir(join(idle.root, 'sys/kernel/random'), { recursive: true });
    await writeFile(
      join(idle.root, 'sys/kernel/random/boot_id'),
      '0a1b2c3d-0000-4000-8000-000000000001\n',
    );
    await writeFile(join(idle.root, 'uptime'), '1234.56 4567.89\n');

    expect(await readMachineClock(idle.root)).toEqual({
      bootId: '0a1b2c3d-0000-4000-8000-000000000001',
      uptimeMs: 1_234_560,
    });
  });

  it('should read nothing where the kernel offers no clock', async () => {
    await using idle = await createIdleRoot(0);

    expect(await readMachineClock(idle.root)).toBeUndefined();
  });
});
