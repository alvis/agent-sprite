import { describe, expect, it } from 'vitest';

import { summarizeMachine, validateMachineName } from '#application/machine';

import { dependencies } from '../mocks/dependencies';

import type { WorkstationRecord } from '#domain/workstation';

const workstation = {
  id: 'machine-id',
  name: 'workstation',
  organization: 'organization',
  state: 'running',
  metadata: { setup: 'not recorded' },
} satisfies WorkstationRecord;

describe('fn:validateMachineName', () => {
  it('should reject a hostname that cannot name a workstation', () => {
    expect(() => validateMachineName('invalid hostname')).toThrow(
      expect.objectContaining({ code: 'INPUT' }),
    );
  });
});

describe('fn:summarizeMachine', () => {
  it.each([{ id: '' }, { organization: '' }])(
    'should reject a provider record missing immutable identity: %j',
    (identity) => {
      expect(() =>
        summarizeMachine(dependencies, { ...workstation, ...identity }),
      ).toThrow(expect.objectContaining({ code: 'PROVIDER' }));
    },
  );
});
