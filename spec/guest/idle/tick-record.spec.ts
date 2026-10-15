import { describe, expect, it } from 'vitest';

import { readTick, writeTick } from '#guest/idle/tick-record';

import { createIdleRoot } from '../../fixtures/idle-root';

import type { MachineClock } from '#guest/idle/machine-clock';

const SECOND = 1_000;
const T0 = Date.parse('2026-10-13T12:00:00.000Z');

/**
 * builds a boot clock reading
 * @param bootId the kernel's boot id
 * @param uptimeMs guest uptime in milliseconds
 * @returns the reader a context takes
 */
function machine(
  bootId: string,
  uptimeMs: number,
): () => Promise<MachineClock> {
  return async () => ({ bootId, uptimeMs });
}

describe('fn:readTick', () => {
  const written = {
    lastTickAt: T0,
    awakeSince: T0 - 120 * SECOND,
    enteringSince: T0,
  };

  it.each([
    [
      'the same boot ran on',
      machine('boot-1', 1_000_000 + 60 * SECOND),
      { awakeSince: written.awakeSince, enteringSince: T0 },
    ],
    [
      'the machine was cold booted within the tick gap',
      machine('boot-2', 5 * SECOND),
      { awakeSince: T0 + 60 * SECOND },
    ],
    [
      'the machine was frozen and resumed within the tick gap',
      machine('boot-1', 1_000_000 + SECOND),
      { awakeSince: T0 + 60 * SECOND },
    ],
  ])('should read the record when %s', async (_, clock, expected) => {
    await using idle = await createIdleRoot(T0);
    await writeTick(
      { ...idle.context, machineClock: machine('boot-1', 1_000_000) },
      written,
    );

    expect(
      await readTick(
        { root: idle.root, machineClock: clock },
        T0 + 60 * SECOND,
      ),
    ).toEqual(expected);
  });

  it('should restart the grace when the record carries no boot stamp', async () => {
    await using idle = await createIdleRoot(T0);
    await writeTick(idle.context, written);

    expect(
      await readTick(
        { root: idle.root, machineClock: machine('boot-1', 1_000_000) },
        T0 + 60 * SECOND,
      ),
    ).toEqual({ awakeSince: T0 + 60 * SECOND });
  });

  it('should read the record by the wall clock alone where no boot clock exists', async () => {
    await using idle = await createIdleRoot(T0);
    await writeTick(idle.context, written);

    expect(await readTick({ root: idle.root }, T0 + 60 * SECOND)).toEqual({
      awakeSince: written.awakeSince,
      enteringSince: T0,
    });
  });
});
