import { describe, expect, it, vi } from 'vitest';

import { ComponentLedger } from '#guest/install-tools/ledger';
import { npmComponent } from '#guest/install-tools/npm';

import {
  programOf,
  ranPrograms,
  runnerFor,
  toolsWith,
} from '../../fixtures/install-tools.js';

import type { RunTool } from '#guest/install-tools/agent';
import type { NpmPackage } from '#guest/install-tools/npm';

const NPM = '/opt/open-agent/node/bin/npm';
const VIEW = `${NPM} view @example/cli@latest version`;
const NODE = '/opt/open-agent/node/bin/node';
const READ_VERSION =
  "console.log(JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).version)";
const MANIFEST =
  '/home/agent/.local/lib/node_modules/@example/cli/package.json';
const READ = [NODE, '-e', READ_VERSION, MANIFEST].join(' ');
const CLI: NpmPackage = {
  component: 'example',
  package: '@example/cli',
  probe: ['example', '--version'],
};

describe('fn:npmComponent', () => {
  it('should leave a package alone when its manifest reports the registry latest and its program runs', async () => {
    const run = runnerFor({
      [VIEW]: '3.1.0\n',
      [READ]: '3.1.0\n',
      'example --version': 'example 3.1.0 (build 9)\n',
    });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(npmComponent(toolsWith({ run }), CLI));

    expect(ranPrograms(run)).toEqual([
      [NPM, 'view', '@example/cli@latest', 'version'],
      [NODE, '-e', READ_VERSION, MANIFEST],
      ['example', '--version'],
    ]);
    expect(ledger.outcomes()).toEqual({
      example: { status: 'skipped', version: '3.1.0' },
    });
  });

  it('should install the exact registry version when the manifest reports another', async () => {
    const run = runnerFor({
      [VIEW]: '3.1.0\n',
      [READ]: ['3.0.2\n', '3.1.0\n'],
      'example --version': ['3.0.2\n', '3.1.0\n'],
    });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(npmComponent(toolsWith({ run }), CLI));

    expect(
      ranPrograms(run).filter(([, command]) => command === 'install'),
    ).toEqual([
      [
        NPM,
        'install',
        '--global',
        '--prefix',
        '/home/agent/.local',
        '@example/cli@3.1.0',
      ],
    ]);
    expect(ledger.outcomes()).toEqual({
      example: { status: 'installed', version: '3.1.0' },
    });
  });

  it('should install a package that is not on disk', async () => {
    const run = runnerFor({
      [VIEW]: '3.1.0\n',
      [READ]: [new Error('ENOENT: no such file'), '3.1.0\n'],
      'example --version': 'example 3.1.0\n',
    });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(npmComponent(toolsWith({ run }), CLI));

    expect(ledger.outcomes()).toEqual({
      example: { status: 'installed', version: '3.1.0' },
    });
  });

  it('should install a package whose manifest is current but whose program does not run', async () => {
    const run = runnerFor({
      [VIEW]: '3.1.0\n',
      [READ]: '3.1.0\n',
      'example --version': [
        new Error('example: command not found'),
        'example 3.1.0\n',
      ],
    });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(npmComponent(toolsWith({ run }), CLI));

    expect(ranPrograms(run).some(([, command]) => command === 'install')).toBe(
      true,
    );
    expect(ledger.outcomes()).toEqual({
      example: { status: 'installed', version: '3.1.0' },
    });
  });

  it('should install the final release over an installed beta of the same version', async () => {
    const run = runnerFor({
      [VIEW]: '3.1.0\n',
      [READ]: ['3.1.0-beta.2\n', '3.1.0\n'],
      'example --version': 'example 3.1.0\n',
    });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(npmComponent(toolsWith({ run }), CLI));

    expect(
      ranPrograms(run).filter(([, command]) => command === 'install'),
    ).toEqual([
      [
        NPM,
        'install',
        '--global',
        '--prefix',
        '/home/agent/.local',
        '@example/cli@3.1.0',
      ],
    ]);
    expect(ledger.outcomes()).toEqual({
      example: { status: 'installed', version: '3.1.0' },
    });
  });

  it('should leave a package alone when the registry latest is a prerelease it already has', async () => {
    const run = runnerFor({
      [VIEW]: '3.2.0-rc.1\n',
      [READ]: '3.2.0-rc.1\n',
      'example --version': 'example 3.2.0\n',
    });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(npmComponent(toolsWith({ run }), CLI));

    expect(ranPrograms(run).some(([, command]) => command === 'install')).toBe(
      false,
    );
    expect(ledger.outcomes()).toEqual({
      example: { status: 'skipped', version: '3.2.0-rc.1' },
    });
  });

  it('should fail a package whose manifest still reports the old version after the install', async () => {
    const run = runnerFor({
      [VIEW]: '3.1.0\n',
      [READ]: '3.0.2\n',
      'example --version': 'example 3.0.2\n',
    });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(npmComponent(toolsWith({ run }), CLI));

    expect(ledger.outcomes()).toEqual({
      example: {
        status: 'failed',
        error: 'installed version does not match the release',
      },
    });
  });

  it('should read the version of a package without a program from its own manifest', async () => {
    const manifest = '/home/agent/.local/lib/node_modules/ws/package.json';
    const run = vi.fn<RunTool>(async (executable, args) => {
      const [program, ...rest] = programOf(executable, args);

      return program === NPM && rest[0] === 'view'
        ? '8.18.3\n'
        : rest.at(-1) === manifest
          ? '8.18.3\n'
          : '';
    });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(
      npmComponent(toolsWith({ run }), { component: 'ws', package: 'ws' }),
    );

    expect(ledger.outcomes()).toEqual({
      ws: { status: 'skipped', version: '8.18.3' },
    });
  });

  it('should fail the package when the registry cannot be reached', async () => {
    const run = runnerFor({ [VIEW]: new Error('getaddrinfo ENOTFOUND') });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(npmComponent(toolsWith({ run }), CLI));

    expect(ranPrograms(run)).toEqual([
      [NPM, 'view', '@example/cli@latest', 'version'],
    ]);
    expect(ledger.outcomes()).toEqual({
      example: {
        status: 'failed',
        error: 'latest version could not be resolved',
      },
    });
  });

  it('should fail the package when the registry reports no release version', async () => {
    const run = runnerFor({ [VIEW]: 'npm notice\n' });
    const ledger = new ComponentLedger(() => undefined);

    await ledger.ensure(npmComponent(toolsWith({ run }), CLI));

    expect(ledger.outcomes()).toEqual({
      example: {
        status: 'failed',
        error: 'latest version could not be resolved',
      },
    });
  });
});
