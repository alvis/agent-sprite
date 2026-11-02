import { describe, expect, it } from 'vitest';

import { settleInspectionResults } from '#adapters/guest/inspection/results';
import { InteractionExit } from '#kernel/navigation';

import { environmentOf } from '../../../fixtures/environment';
import { DISABLED_NETWORK_PROFILE } from '../../../fixtures/profile';

const RECORDED = {
  environment: environmentOf(DISABLED_NETWORK_PROFILE, {
    networkIdentity: {
      network: 'none',
      deviceId: 'retained',
      ip: '100.64.0.1',
    },
  }),
};

describe('fn:settleInspectionResults', () => {
  it('should retain recorded identity and identify every unavailable probe without a diagnostic', () => {
    const rejected = { status: 'rejected', reason: new Error('') } as const;

    const result = settleInspectionResults(RECORDED, [
      rejected,
      rejected,
      rejected,
      rejected,
    ]);

    expect(result).toEqual({
      ...RECORDED,
      services: [],
      native: undefined,
      network: {
        deviceId: 'retained',
        ip: '100.64.0.1',
        online: false,
        dnsReady: false,
        skipped: false,
        reason: 'network probe unavailable',
      },
      hub: {
        reachable: false,
        skipped: false,
        reason: 'proxy probe unavailable',
      },
      probeFailures: ['services', 'network', 'native', 'proxy'].map(
        (probe) => ({ probe, reason: `${probe} probe unavailable` }),
      ),
    });
  });

  it.each([
    new InteractionExit('cancel'),
    new SyntaxError('syntax'),
    new TypeError('type'),
    new ReferenceError('reference'),
    new RangeError('range'),
  ])('should rethrow navigation and programming failures: %s', (error) => {
    const rejected = { status: 'rejected', reason: error } as const;

    expect(() =>
      settleInspectionResults(RECORDED, [
        rejected,
        rejected,
        rejected,
        rejected,
      ]),
    ).toThrow(error);
  });
});
