import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { ComponentLedger } from '#guest/install-tools/ledger';
import { installNetworks } from '#guest/install-tools/networks';

import type { NetworkComponent } from '#drivers/component-types';
import type { RunTool } from '#guest/install-tools/agent';

const { root } = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir: temporaryRoot } = await import('node:os');
  const { join: joinPath } = await import('node:path');

  return {
    root: await mkdtemp(
      joinPath(temporaryRoot(), 'open-agent-install-networks-'),
    ),
  };
});

vi.mock('#guest/guest-root', () => ({
  GUEST_ROOT: root,
  AGENT_HOME: '/home/agent',
}));

// the temporary root is not root-owned, so the trust check is a recording
// stand-in; the refusal itself is proven in the native-files specs
const { trusted } = vi.hoisted(() => ({
  trusted: vi.fn(async (path: string) => path),
}));
vi.mock('#guest/native-files', () => ({ resolveTrustedFile: trusted }));

// the real context bootstraps the guest when imported; the tools it lends
// are passed through untouched, so stand-ins prove the injection
const { run } = vi.hoisted(() => ({
  run: vi.fn<RunTool>(async () => ''),
}));
vi.mock('#guest/install-tools/context', () => ({
  download: vi.fn(),
  downloadText: vi.fn(),
  link: vi.fn(),
  run,
  temporary: 'install-scratch',
}));

const LATEST = '1.2.0';

/**
 * describes a fixture network whose driver deploys its own installer module
 * @param id network and component name
 * @returns the network the host would record for the guest
 */
function networkOf(id: string): NetworkComponent {
  return {
    id,
    component: id,
    feed: `https://releases.example/${id}/`,
    installer: `${id}-install.js`,
    probe: [id, '--version'],
  };
}

/**
 * deploys an installer module that records what it was asked to install
 * @param network network whose installer is written
 * @param latest body of `latestRelease`
 */
async function deployInstaller(
  network: NetworkComponent,
  latest: string,
): Promise<void> {
  await writeFile(
    join(root, network.installer),
    [
      "import { writeFileSync } from 'node:fs';",
      'export async function latestRelease(network, tools) {',
      `  ${latest}`,
      '}',
      'export async function installRelease(network, tools, version) {',
      `  writeFileSync(new URL('./${network.id}-calls.json', import.meta.url), JSON.stringify({`,
      '    network,',
      '    version,',
      '    tools: Object.keys(tools).sort(),',
      '    toolsDirectory: tools.toolsDirectory,',
      '    temporary: tools.temporary,',
      '  }));',
      '}',
    ].join('\n'),
  );
}

/**
 * lets the version probes report a tool's output in turn, after forgetting the earlier calls
 * @param outputs what the probed program prints, or the failure it raises, at each start
 */
function probeReports(...outputs: Array<string | Error>): void {
  run.mockClear();
  for (const output of outputs) {
    run.mockImplementationOnce(async () => {
      if (output instanceof Error) {
        throw output;
      }

      return output;
    });
  }
}

/**
 * tells whether the installer ran for a network
 * @param network network to look up
 * @returns whether the installer left its record
 */
async function installerRan(network: NetworkComponent): Promise<boolean> {
  return access(join(root, `${network.id}-calls.json`)).then(
    () => true,
    () => false,
  );
}

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('fn:installNetworks', () => {
  it('should install the resolved version through the injected tools when the tool is absent', async () => {
    const network = networkOf('absent');
    const ledger = new ComponentLedger(vi.fn());
    await deployInstaller(network, `return '${LATEST}';`);
    probeReports(
      new Error('absent: command not found'),
      `absent version ${LATEST}\n`,
    );

    await installNetworks([network], ledger);

    expect(run.mock.calls).toEqual([
      [network.probe[0], network.probe.slice(1), true],
      [network.probe[0], network.probe.slice(1), true],
    ]);

    expect(
      JSON.parse(await readFile(join(root, 'absent-calls.json'), 'utf8')),
    ).toEqual({
      network,
      version: LATEST,
      tools: [
        'download',
        'downloadText',
        'link',
        'run',
        'temporary',
        'toolsDirectory',
      ],
      toolsDirectory: `${root}/tools`,
      temporary: 'install-scratch',
    });
    expect(ledger.outcomes()).toEqual({
      absent: { status: 'installed', version: LATEST },
    });
  });

  it('should leave a tool alone when it already reports the latest version', async () => {
    const network = networkOf('current');
    const ledger = new ComponentLedger(vi.fn());
    await deployInstaller(network, `return '${LATEST}';`);
    probeReports(`current version ${LATEST}\n`);

    await installNetworks([network], ledger);

    expect(run.mock.calls).toEqual([
      [network.probe[0], network.probe.slice(1), true],
    ]);
    expect(await installerRan(network)).toBe(false);
    expect(ledger.outcomes()).toEqual({
      current: { status: 'skipped', version: LATEST },
    });
  });

  it('should install when the tool reports a different version', async () => {
    const network = networkOf('older');
    const ledger = new ComponentLedger(vi.fn());
    await deployInstaller(network, `return '${LATEST}';`);
    probeReports('older version 1.1.9\n', `older version ${LATEST}\n`);

    await installNetworks([network], ledger);

    expect(await installerRan(network)).toBe(true);
    expect(ledger.outcomes()).toEqual({
      older: { status: 'installed', version: LATEST },
    });
  });

  it('should fail the network and install nothing when its latest version cannot be resolved', async () => {
    const network = networkOf('unresolved');
    const note = vi.fn<(line: string) => void>();
    const ledger = new ComponentLedger(note);
    await deployInstaller(
      network,
      "throw new Error('The release feed lists no version');",
    );

    await installNetworks([network], ledger);

    expect(await installerRan(network)).toBe(false);
    expect(ledger.outcomes()).toEqual({
      unresolved: {
        status: 'failed',
        error: 'latest version could not be resolved',
      },
    });
    expect(note.mock.calls).toEqual([
      ['Component unresolved failed: The release feed lists no version'],
      [expect.stringMatching(/^Component unresolved took \d+ ms$/)],
    ]);
  });

  it.each([['1.2'], ['v1.2.3'], ['1.2.3-rc1'], ['../1.2.3'], ['']])(
    'should fail the network and install nothing when its driver reports %j as the latest version',
    async (reported) => {
      const network = networkOf(`invalid${String(reported.length)}`);
      const ledger = new ComponentLedger(vi.fn());
      await deployInstaller(network, `return ${JSON.stringify(reported)};`);
      probeReports();

      await installNetworks([network], ledger);

      expect(await installerRan(network)).toBe(false);
      expect(ledger.outcomes()).toEqual({
        [network.id]: {
          status: 'failed',
          error: 'latest version could not be resolved',
        },
      });
    },
  );

  it('should import only the path the trust check resolves', async () => {
    const network = { ...networkOf('resolved'), installer: 'unresolved.js' };
    await deployInstaller(networkOf('resolved'), `return '${LATEST}';`);
    trusted.mockResolvedValueOnce(join(root, 'resolved-install.js'));

    await installNetworks([network], new ComponentLedger(vi.fn()));

    expect(trusted).toHaveBeenLastCalledWith(join(root, 'unresolved.js'));
    expect(await installerRan(networkOf('resolved'))).toBe(true);
  });

  it('should not import an installer the trust check refuses', async () => {
    await writeFile(
      join(root, 'planted-install.js'),
      "throw new Error('planted code ran');\n",
    );
    trusted.mockRejectedValueOnce(new Error('Untrusted root execution path'));

    await expect(
      installNetworks([networkOf('planted')], new ComponentLedger(vi.fn())),
    ).rejects.toThrow('Untrusted root execution path');
  });

  it('should refuse a module that exports no installer', async () => {
    await writeFile(
      join(root, 'inert-install.js'),
      'export const version = 1;\n',
    );

    await expect(
      installNetworks([networkOf('inert')], new ComponentLedger(vi.fn())),
    ).rejects.toThrow('No installer exists for network inert');
  });
});
