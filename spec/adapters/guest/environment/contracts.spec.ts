import { describe, expect, it } from 'vitest';

import { parseEnvironment } from '#adapters/guest/environment/contracts';
import { registry } from '#composition/registry';

import { environmentOf } from '../../../fixtures/environment';
import { DISABLED_NETWORK_PROFILE } from '../../../fixtures/profile';

const RECORDED = environmentOf(DISABLED_NETWORK_PROFILE);

describe('fn:parseEnvironment', () => {
  it('should accept a persisted environment and retain unknown top-level evidence', () => {
    const persisted = {
      ...RECORDED,
      futureEvidence: { source: 'guest' },
    };

    const parsed = parseEnvironment(registry, JSON.stringify(persisted));

    expect(parsed).toEqual(persisted);
  });

  it('should reject an unsupported format without treating it as a malformed record', () => {
    const persisted = { ...RECORDED, schema: 2 };

    expect(() => parseEnvironment(registry, JSON.stringify(persisted))).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
  });

  it('should reject a record without a schema as malformed', () => {
    const { schema: _schema, ...persisted } = RECORDED;

    expect(() => parseEnvironment(registry, JSON.stringify(persisted))).toThrow(
      /malformed/u,
    );
  });

  it('should reject a malformed persisted field after accepting its schema', () => {
    const persisted = { ...RECORDED, schedule: { dueDays: 0 } };

    expect(() => parseEnvironment(registry, JSON.stringify(persisted))).toThrow(
      /schedule is malformed/u,
    );
  });

  it('should reject an unresolved agent service reference', () => {
    const persisted = {
      ...RECORDED,
      agent: { ...RECORDED.agent, service: 'missing-service' },
    };

    expect(() => parseEnvironment(registry, JSON.stringify(persisted))).toThrow(
      /agent's service .* is not defined/u,
    );
  });
});
