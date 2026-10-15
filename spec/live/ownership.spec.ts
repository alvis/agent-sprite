import { describe, expect, it } from 'vitest';

import { RETIRED_PRODUCT } from './identity.js';
import {
  assertOwnedWorkstation,
  foreignIdentifiers,
  isRunWorkstation,
} from './ownership.js';

const runId = 'oa-live-0a1b2c3d';
const label = 'open-agent';

describe('fn:isRunWorkstation', () => {
  it('should accept only names inside the run prefix', () => {
    expect(
      ['oa-live-0a1b2c3d-b', 'oa-live-0a1b2c3d', 'oa-live-0a1b2c3e-b'].map(
        (name) => isRunWorkstation(name, runId),
      ),
    ).toEqual([true, false, false]);
  });

  it('should reject every name when the run id is malformed', () => {
    expect(isRunWorkstation('-b', '')).toBe(false);
  });
});

describe('fn:assertOwnedWorkstation', () => {
  it('should accept the exact managed workstation of the current run', () => {
    expect(() =>
      assertOwnedWorkstation(
        { name: 'oa-live-0a1b2c3d-b', labels: ['other', label] },
        { name: 'oa-live-0a1b2c3d-b', runId, label },
      ),
    ).not.toThrow();
  });

  it('should refuse a provider record whose name differs from the request', () => {
    expect(() =>
      assertOwnedWorkstation(
        { name: 'oa-live-0a1b2c3d-i', labels: [label] },
        { name: 'oa-live-0a1b2c3d-b', runId, label },
      ),
    ).toThrow(
      new Error(
        'Refusing to delete oa-live-0a1b2c3d-i: expected exactly oa-live-0a1b2c3d-b',
      ),
    );
  });

  it('should refuse a workstation outside the current run prefix', () => {
    expect(() =>
      assertOwnedWorkstation(
        { name: 'open-agent-primary', labels: [label] },
        { name: 'open-agent-primary', runId, label },
      ),
    ).toThrow(
      new Error(
        'Refusing to delete open-agent-primary: outside live run oa-live-0a1b2c3d',
      ),
    );
  });

  it('should refuse a workstation without the managed label', () => {
    expect(() =>
      assertOwnedWorkstation(
        { name: 'oa-live-0a1b2c3d-b', labels: ['other'] },
        { name: 'oa-live-0a1b2c3d-b', runId, label },
      ),
    ).toThrow(
      new Error(
        'Refusing to delete oa-live-0a1b2c3d-b: missing managed label open-agent',
      ),
    );
  });
});

describe('fn:foreignIdentifiers', () => {
  const identity = {
    labels: ['open-agent', 'open-agent-schema-v1', 'open-agent-setup-ready'],
    guestPaths: ['/opt/open-agent', '/etc/cron.d/open-agent', '/opt/node'],
    schedule:
      '* * * * * root /opt/open-agent/node/bin/node /opt/open-agent/guest/updater.js',
  };

  it('should accept a workstation carrying only product identifiers', () => {
    expect(foreignIdentifiers(identity)).toEqual([]);
  });

  it('should report previous-name labels, paths and schedules', () => {
    expect(
      foreignIdentifiers({
        labels: [...identity.labels, RETIRED_PRODUCT],
        guestPaths: [...identity.guestPaths, `/opt/${RETIRED_PRODUCT}`],
        schedule: `${identity.schedule} /opt/${RETIRED_PRODUCT}/x`,
      }),
    ).toEqual([
      `foreign ${RETIRED_PRODUCT}`,
      `foreign /opt/${RETIRED_PRODUCT}`,
      'foreign schedule',
    ]);
  });

  it('should report missing product identifiers', () => {
    expect(
      foreignIdentifiers({ labels: [], guestPaths: [], schedule: '' }),
    ).toHaveLength(5);
  });
});
