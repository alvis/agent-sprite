import { mkdir, mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  installRelease,
  latestRelease,
} from '#drivers/networks/tailscale/guest/tailscale-install';

import {
  ranPrograms,
  runnerFor,
  toolsWith,
} from '../../../fixtures/install-tools.js';

import type { NetworkComponent } from '#drivers/component-types';

const ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';
const NETWORK: NetworkComponent = {
  id: 'tailscale',
  component: 'tailscale',
  feed: 'https://pkgs.example/stable/?mode=json',
  installer: 'drivers/networks/tailscale/guest/tailscale-install.js',
  probe: ['tailscale', 'version'],
};
const FEED = JSON.stringify({
  Tarballs: {
    amd64: 'tailscale_1.90.1_amd64.tgz',
    arm64: 'tailscale_1.90.1_arm64.tgz',
  },
});

describe('fn:latestRelease', () => {
  it('should report the version of the archive the feed lists for this architecture', async () => {
    const tools = toolsWith({ downloadText: vi.fn(async () => FEED) });

    await expect(latestRelease(NETWORK, tools)).resolves.toBe('1.90.1');
    expect(tools.downloadText).toHaveBeenCalledWith(NETWORK.feed);
  });

  it('should refuse a feed that lists no archive for this architecture', async () => {
    const tools = toolsWith({
      downloadText: vi.fn(async () => JSON.stringify({ Tarballs: {} })),
    });

    await expect(latestRelease(NETWORK, tools)).rejects.toEqual(
      new Error('Tailscale release metadata is invalid'),
    );
  });

  it('should refuse an archive name that carries no release version', async () => {
    const tools = toolsWith({
      downloadText: vi.fn(async () =>
        JSON.stringify({
          Tarballs: { [ARCH]: 'tailscale_unstable_amd64.tgz' },
        }),
      ),
    });

    await expect(latestRelease(NETWORK, tools)).rejects.toEqual(
      new Error('Tailscale release metadata is invalid'),
    );
  });
});

describe('fn:installRelease', () => {
  it('should download, unpack and link both Tailscale programs at the requested version', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tailscale-install-'),
    );
    await mkdir(join(directory.path, `tailscale_1.90.1_${ARCH}`));
    const run = runnerFor({});
    const tools = toolsWith({
      run,
      downloadText: vi.fn(async () => FEED),
      temporary: directory.path,
    });

    await installRelease(NETWORK, tools, '1.90.1');

    expect(tools.download).toHaveBeenCalledWith(
      `https://pkgs.example/stable/tailscale_1.90.1_${ARCH}.tgz`,
      'tailscale.tgz',
    );
    expect(ranPrograms(run)).toEqual([
      [
        '/usr/bin/apt-get',
        'install',
        '-y',
        '-qq',
        '--no-upgrade',
        '--no-install-recommends',
        'iproute2',
      ],
      [
        '/usr/bin/tar',
        '-xzf',
        join(directory.path, 'tailscale.tgz'),
        '-C',
        directory.path,
      ],
      [
        '/usr/bin/install',
        '-m',
        '0755',
        join(directory.path, `tailscale_1.90.1_${ARCH}`, 'tailscale'),
        '/opt/open-agent/tools/tailscale',
      ],
      [
        '/usr/bin/install',
        '-m',
        '0755',
        join(directory.path, `tailscale_1.90.1_${ARCH}`, 'tailscaled'),
        '/opt/open-agent/tools/tailscaled',
      ],
    ]);
    expect(vi.mocked(tools.link).mock.calls).toEqual([
      ['/opt/open-agent/tools/tailscale', '/usr/local/bin/tailscale'],
      ['/opt/open-agent/tools/tailscaled', '/usr/local/bin/tailscaled'],
    ]);
  });

  it('should install nothing when the feed moved on after the version was resolved', async () => {
    const run = runnerFor({});
    const tools = toolsWith({ run, downloadText: vi.fn(async () => FEED) });

    await expect(installRelease(NETWORK, tools, '1.89.0')).rejects.toEqual(
      new Error('Tailscale release changed while it was being installed'),
    );
    expect(tools.download).not.toHaveBeenCalled();
    expect(ranPrograms(run)).toEqual([]);
  });

  it('should refuse an archive that unpacks to no Tailscale directory', async () => {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'open-agent-tailscale-empty-'),
    );
    const tools = toolsWith({
      downloadText: vi.fn(async () => FEED),
      temporary: directory.path,
    });

    await expect(installRelease(NETWORK, tools, '1.90.1')).rejects.toEqual(
      new Error('Tailscale archive is incomplete'),
    );
  });
});
