import { describe, expect, it } from 'vitest';

import { t3Readiness } from '#drivers/agents/t3/readiness';

import type { T3Environment } from '#drivers/agents/t3/evidence';
import type { GuestServiceState } from '#drivers/guest-channel';

const RUNNING: GuestServiceState[] = [
  { name: 't3-code', status: 'running', needs: [] },
];
const ANSWERED: T3Environment = {
  ok: true,
  serverVersion: '0.0.46-nightly.20261014.3118',
  orchestrationProtocolVersion: 2,
};

describe('fn:t3Readiness', () => {
  it('should pass the service and environment endpoint findings when both are healthy', () => {
    const result = t3Readiness({ services: RUNNING, environment: ANSWERED });

    expect(result).toEqual({
      service: [{ name: 'T3 service', status: 'passed' }],
      environment: [{ name: 'T3 environment endpoint', status: 'passed' }],
    });
  });

  it('should fail the environment endpoint finding when the endpoint did not answer', () => {
    const result = t3Readiness({
      services: RUNNING,
      environment: { ok: false, reason: 'environment-endpoint-unreachable' },
    });

    expect(result.environment).toEqual([
      { name: 'T3 environment endpoint', status: 'failed' },
    ]);
  });

  it('should fail both findings when nothing could be observed', () => {
    const result = t3Readiness({ services: [], environment: undefined });

    expect(result).toEqual({
      service: [{ name: 'T3 service', status: 'failed' }],
      environment: [{ name: 'T3 environment endpoint', status: 'failed' }],
    });
  });
});
