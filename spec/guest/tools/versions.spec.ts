import { describe, expect, it } from 'vitest';

import { runWithBrew } from '../../mocks/brew';

import type { BrewScenario } from '../../mocks/brew';

const ENVIRONMENT = {
  tools: [
    { name: 'jq', source: { kind: 'brew', formula: 'jq' } },
    { name: 'python', source: { kind: 'brew', formula: 'python3' } },
    { name: 'widget', source: { kind: 'brew', formula: 'acme/tools/widget' } },
    { name: 'gone', source: { kind: 'brew', formula: 'gone' }, version: '9' },
    { name: 'claude', source: { kind: 'npm', package: 'claude' } },
    { name: 'curl', source: { kind: 'system', packages: ['curl'] } },
  ],
};

const INSTALLED: BrewScenario = {
  installed: { 'jq': '1.7.1', 'python@3.13': '3.13.1', 'widget': '2.0' },
  aliases: { python3: 'python@3.13' },
};

const RECORD = `OA_VERSIONS_JQ=$(command -v jq)
oa_npm_version() { echo 1.0.0; }
oa_tools_record_versions "$OA_TEST_WORK/environment.json"`;

async function record(scenario: BrewScenario, environment = ENVIRONMENT) {
  const run = await runWithBrew({
    scenario,
    libraries: ['tools/versions.sh'],
    script: RECORD,
    files: { 'environment.json': JSON.stringify(environment) },
  });

  return {
    exitCode: run.exitCode,
    calls: run.calls,
    tools: (JSON.parse(run.environment) as { tools: unknown[] }).tools,
  };
}

describe('fn:oa_tools_record_versions', () => {
  it('should read listed formulae from one listing and ask brew alone for an alias, a tap formula and a miss', async () => {
    const result = await record(INSTALLED);

    expect(result).toEqual({
      exitCode: 0,
      calls: [
        'list --formula --versions',
        'list --formula --versions python3',
        'list --formula --versions acme/tools/widget',
        'list --formula --versions gone',
      ],
      tools: [
        { ...ENVIRONMENT.tools[0], version: '1.7.1' },
        { ...ENVIRONMENT.tools[1], version: '3.13.1' },
        { ...ENVIRONMENT.tools[2], version: '2.0' },
        { name: 'gone', source: { kind: 'brew', formula: 'gone' } },
        { ...ENVIRONMENT.tools[4], version: '1.0.0' },
        ENVIRONMENT.tools[5],
      ],
    });
  });

  it('should ask brew for each formula alone when the listing fails, recording the same versions', async () => {
    const listed = await record(INSTALLED);

    const unlisted = await record({ ...INSTALLED, shouldFailListing: true });

    expect(unlisted).toEqual({
      exitCode: 0,
      calls: [
        'list --formula --versions',
        'list --formula --versions jq',
        'list --formula --versions python3',
        'list --formula --versions acme/tools/widget',
        'list --formula --versions gone',
      ],
      tools: listed.tools,
    });
  });

  it('should not run brew when no tool comes from Homebrew', async () => {
    const result = await record(INSTALLED, {
      tools: [ENVIRONMENT.tools[4]!, ENVIRONMENT.tools[5]!],
    });

    expect(result).toEqual({
      exitCode: 0,
      calls: [],
      tools: [
        { ...ENVIRONMENT.tools[4], version: '1.0.0' },
        ENVIRONMENT.tools[5],
      ],
    });
  });
});
