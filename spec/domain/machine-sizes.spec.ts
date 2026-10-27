import { describe, expect, it } from 'vitest';

import { isSameMachine } from '#domain/machine-sizes';

import type { MachineOffer } from '#domain/declarations';

const REQUESTED: MachineOffer = {
  label: 'shared-cpu-2x',
  cpus: 2,
  memoryGb: 2,
};

describe('fn:isSameMachine', () => {
  it.each([
    { case: 'no reported size', current: undefined, same: false },
    { case: 'matching size', current: REQUESTED, same: true },
    {
      case: 'different label',
      current: { ...REQUESTED, label: 'performance-2x' },
      same: false,
    },
    {
      case: 'different CPU count under one label',
      current: { ...REQUESTED, cpus: 4 },
      same: false,
    },
    {
      case: 'different memory under one label',
      current: { ...REQUESTED, memoryGb: 4 },
      same: false,
    },
  ])('should recognize $case', ({ current, same }) => {
    expect(isSameMachine(current, REQUESTED)).toBe(same);
  });
});
