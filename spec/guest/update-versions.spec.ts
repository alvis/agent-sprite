import { describe, expect, it, vi } from 'vitest';

import { probeInstalledVersions } from '#guest/update-versions';

const { probed } = vi.hoisted(() => ({ probed: [] as string[][] }));

vi.mock('#guest/run-child', () => ({
  runChild: async (_file: string, args: string[]) => {
    probed.push(args.slice(3));

    return `${args.at(-2)} \n`;
  },
}));

vi.mock('#guest/native-files', () => ({
  resolveTrustedFile: async (path: string) => path,
}));

vi.mock('#guest/component-catalog', () => ({
  readComponentCatalog: async () => ({
    shellAccounts: [],
    agent: {
      id: 'agent',
      component: 'agent',
      package: 'agent',
      probe: ['agent', '--version'],
      harnessNames: {},
      httpPort: 4000,
    },
    runtime: {
      component: 'runtime',
      package: 'runtime',
      probe: ['runtime', '--version'],
    },
    packages: [],
    networks: [],
  }),
}));

vi.mock('#guest/harness-catalog', () => ({
  readHarnessCatalog: async () => [
    {
      id: 'fixture',
      component: 'fixture',
      package: 'fixture',
      probe: ['fixture', '--version'],
      environment: {},
      adapter: {
        component: 'fixture-acp',
        package: 'fixture-acp',
        probe: ['fixture-acp', '--version'],
      },
    },
  ],
}));

describe('fn:probeInstalledVersions', () => {
  it('should report the adapter a harness provides beside the harness', async () => {
    const steps: string[] = [];

    const versions = await probeInstalledVersions({}, (step) => {
      steps.push(step);
    });

    expect(Object.keys(versions)).toEqual([
      'guest-node',
      'git',
      'jj',
      'gh',
      'node',
      'pnpm',
      'python3',
      'uv',
      'rustup',
      'httpie',
      'agent-browser',
      'rust',
      'google-chrome',
      'fixture',
      'fixture-acp',
      'agent',
      'runtime',
    ]);
    expect(versions['fixture-acp']).toBe('fixture-acp');
    expect(steps).toContain('installed version probe (fixture-acp)');
    expect(probed).toContainEqual(['fixture-acp', '--version']);
  });
});
