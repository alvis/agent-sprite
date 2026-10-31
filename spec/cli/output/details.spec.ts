import { describe, expect, it } from 'vitest';

import { humanResultDetails } from '#cli/output/details';

// The inspection payload can contain incomplete observations from the guest.
describe('fn:humanResultDetails', () => {
  it('should preserve an incomplete machine size instead of inventing dimensions', () => {
    const machine = { machine: { label: 'observed', cpus: 2 } };

    expect(humanResultDetails({ machine })).toEqual({ machine });
  });

  it('should omit absent inspection sections and present the agent environment separately', () => {
    const result = humanResultDetails({
      inspection: {
        native: {
          claude: { available: false },
          agentEnvironment: { ok: false },
        },
        environment: { profile: { options: { minCpus: 2 } } },
        boot: { unsuccessfulSteps: { bootstrap: 'failed' } },
        updates: {},
      },
    });

    expect(result.inspection).toMatchObject({
      'Claude Code': { available: false },
      'Agent environment': { verified: false },
      'Machine requirement': undefined,
      'Installed tools': undefined,
      'services': undefined,
      'Maintenance': { failedTools: undefined },
      'Last boot': {
        status: 'not recorded',
        unsuccessfulSteps: { bootstrap: 'failed' },
      },
    });
  });

  it('should skip unnamed tool records and use only string versions from update observations', () => {
    const result = humanResultDetails({
      inspection: {
        environment: {
          tools: [
            { source: { kind: 'npm' } },
            { name: 'codex', source: { kind: 'npm' } },
          ],
          setup: {
            skipped: [
              { reason: 'unidentified' },
              { name: 'optional', reason: 'no bottle' },
            ],
          },
        },
        updates: {
          tools: [
            { to: 'unidentified' },
            { name: 'codex', to: 1 },
            { name: 'codex', to: '1.2.3\nextra output' },
          ],
        },
      },
    });

    expect(result.inspection).toMatchObject({
      'Installed tools': { codex: '1.2.3' },
      'Skipped tools': { optional: 'no bottle' },
    });
  });

  it.each([
    { governor: { recorded: false }, expected: /not recorded.*unavailable/u },
    {
      governor: { recorded: true, state: {} },
      expected: /no heartbeat.*0 open holds/u,
    },
  ])(
    'should describe incomplete governor observations ($expected)',
    ({ governor, expected }) => {
      expect(
        humanResultDetails({ inspection: { governor } }).inspection,
      ).toMatchObject({
        'Idle governor': expect.stringMatching(expected),
      });
    },
  );
});
