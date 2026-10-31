import { machine } from 'node:os';

import { describe, expect, it } from 'vitest';

import { runWithBrew } from '../../mocks/brew';

import type { BrewScenario } from '../../mocks/brew';

const ENVIRONMENT = {
  tools: [
    { name: 'jq', required: true, source: { kind: 'brew', formula: 'jq' } },
    { name: 'gh', required: true, source: { kind: 'brew', formula: 'gh' } },
    {
      name: 'node',
      required: false,
      source: { kind: 'brew', formula: 'node' },
    },
  ],
};

const INSTALLED = { jq: '1.7.1', gh: '2.60.0', node: '22.1.0' } as const;
const NEWER = { gh: '2.61.0', node: '22.2.0' } as const;

const UPDATE = `OA_VERSIONS_JQ=$(command -v jq)
oa_update_system() { :; }
oa_update_system_clean() { :; }
oa_update_system_clean_roots() { :; }
oa_npm_clean() { :; }
oa_npm_clean_roots() { :; }
oa_rustup_clean() { :; }
oa_rustup_clean_roots() { :; }
oa_links_restore() { :; }
(oa_update_run "$OA_TEST_WORK/environment.json" "$OA_TEST_WORK/update-status.json" \\
  "$(command -v jq)" true 1) >/dev/null 2>&1`;

/** one tool's outcome in update-status.json */
interface ToolOutcome {
  name: string;
  manager: string;
  required: boolean;
  outcome: string;
  from: string | null;
  to: string | null;
  reason?: string;
}

async function update(scenario: Omit<BrewScenario, 'installed'>) {
  const run = await runWithBrew({
    scenario: { installed: INSTALLED, newer: NEWER, ...scenario },
    libraries: ['tools/versions.sh', 'maintenance/updater.sh'],
    script: UPDATE,
    files: { 'environment.json': JSON.stringify(ENVIRONMENT) },
  });
  const status = JSON.parse(run.status) as {
    lastSuccess: string | null;
    tools: ToolOutcome[];
  };
  const recorded = JSON.parse(run.environment) as {
    tools: Array<{ name: string; version?: string }>;
  };

  return {
    upgrades: run.calls.filter((call) => call.startsWith('upgrade')),
    succeeded: status.lastSuccess !== null,
    tools: status.tools,
    versions: Object.fromEntries(
      recorded.tools.map(({ name, version }) => [name, version]),
    ),
  };
}

const outcome = (
  name: keyof typeof INSTALLED,
  recorded: Pick<ToolOutcome, 'outcome' | 'to' | 'reason'>,
): ToolOutcome => ({
  name,
  manager: 'brew',
  required: name !== 'node',
  from: INSTALLED[name],
  ...recorded,
});

describe('fn:oa_update_run', () => {
  it('should run no upgrade when every formula is current', async () => {
    const result = await update({});

    expect(result).toEqual({
      upgrades: [],
      succeeded: true,
      tools: [
        outcome('jq', {
          outcome: 'skipped',
          to: '1.7.1',
          reason: 'it is current',
        }),
        outcome('gh', {
          outcome: 'skipped',
          to: '2.60.0',
          reason: 'it is current',
        }),
        outcome('node', {
          outcome: 'skipped',
          to: '22.1.0',
          reason: 'it is current',
        }),
      ],
      versions: INSTALLED,
    });
  });

  it('should upgrade the outdated formulae in one run and record each in order', async () => {
    const result = await update({ outdated: ['node', 'gh'] });

    expect(result).toEqual({
      upgrades: ['upgrade --formula gh node'],
      succeeded: true,
      tools: [
        outcome('jq', {
          outcome: 'skipped',
          to: '1.7.1',
          reason: 'it is current',
        }),
        outcome('gh', { outcome: 'installed', to: '2.61.0' }),
        outcome('node', { outcome: 'installed', to: '22.2.0' }),
      ],
      versions: { ...INSTALLED, ...NEWER },
    });
  });

  it('should keep an upgrade the run made and retry alone only the formula it left behind', async () => {
    const result = await update({ outdated: ['gh', 'node'], broken: ['node'] });

    expect(result).toEqual({
      upgrades: ['upgrade --formula gh node', 'upgrade --formula node'],
      succeeded: true,
      tools: [
        outcome('jq', {
          outcome: 'skipped',
          to: '1.7.1',
          reason: 'it is current',
        }),
        outcome('gh', { outcome: 'installed', to: '2.61.0' }),
        outcome('node', {
          outcome: 'failed',
          to: '22.1.0',
          reason: 'its brew upgrade failed',
        }),
      ],
      versions: { ...INSTALLED, gh: '2.61.0' },
    });
  });

  it('should fail a required formula whose upgrade fails alone too and withhold the last success', async () => {
    const result = await update({ outdated: ['gh', 'node'], broken: ['gh'] });

    expect(result).toEqual({
      upgrades: ['upgrade --formula gh node', 'upgrade --formula gh'],
      succeeded: false,
      tools: [
        outcome('jq', {
          outcome: 'skipped',
          to: '1.7.1',
          reason: 'it is current',
        }),
        outcome('gh', {
          outcome: 'failed',
          to: '2.60.0',
          reason: 'its brew upgrade failed',
        }),
        outcome('node', { outcome: 'installed', to: '22.2.0' }),
      ],
      versions: { ...INSTALLED, node: '22.2.0' },
    });
  });

  it('should keep a formula whose new version has no bottle out of the run', async () => {
    const result = await update({
      outdated: ['gh', 'node'],
      unbottled: ['node'],
    });

    expect(result).toEqual({
      upgrades: ['upgrade --formula gh'],
      succeeded: true,
      tools: [
        outcome('jq', {
          outcome: 'skipped',
          to: '1.7.1',
          reason: 'it is current',
        }),
        outcome('gh', { outcome: 'installed', to: '2.61.0' }),
        outcome('node', {
          outcome: 'skipped',
          to: '22.1.0',
          reason: `its new version has no bottle for ${machine()}`,
        }),
      ],
      versions: { ...INSTALLED, gh: '2.61.0' },
    });
  });

  it('should fail every formula without upgrading when brew cannot refresh', async () => {
    const result = await update({ outdated: ['gh'], shouldFailRefresh: true });

    expect(result).toEqual({
      upgrades: [],
      succeeded: false,
      tools: [
        outcome('jq', {
          outcome: 'failed',
          to: '1.7.1',
          reason: 'Homebrew could not refresh its formulae',
        }),
        outcome('gh', {
          outcome: 'failed',
          to: '2.60.0',
          reason: 'Homebrew could not refresh its formulae',
        }),
        outcome('node', {
          outcome: 'failed',
          to: '22.1.0',
          reason: 'Homebrew could not refresh its formulae',
        }),
      ],
      versions: INSTALLED,
    });
  });
});
