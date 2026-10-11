import { closeSync } from 'node:fs';
import { access, chmod, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  directory,
  home,
  log,
  temporary,
  run,
  download,
  downloadText,
  link,
} from './install-tools/context.js';
import { isRecord } from './records.js';

const privateMode = 0o600;
try {
  await chmod(`${directory}/install-tools.log`, privateMode);
  await installTools();
} finally {
  try {
    await rm(temporary, { recursive: true, force: true });
  } finally {
    closeSync(log);
  }
}

/** installs system tools before configuring account-owned native harnesses */
async function installTools(): Promise<void> {
  await run('/usr/bin/apt-get', ['update', '-qq']);
  await run('/usr/bin/apt-get', [
    'install',
    '-y',
    '-qq',
    '--no-upgrade',
    '--no-install-recommends',
    'git',
    'iproute2',
    'unzip',
    'cron',
    'build-essential',
    'gettext',
    'libcurl4-openssl-dev',
    'libexpat1-dev',
    'libssl-dev',
    'zlib1g-dev',
  ]);
  await mkdir(`${directory}/tools`, { recursive: true, mode: 0o755 });
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    throw new Error('Unsupported guest architecture');
  }
  await installGit();
  await installRelease('jj-vcs/jj', 'jj');
  await installRelease('cli/cli', 'gh');
  await installTailscale();
  await installHarnesses();
}

/** installs the latest stable Git into a versioned root-owned prefix */
async function installGit(): Promise<void> {
  const index = await downloadText(
    'https://mirrors.edge.kernel.org/pub/software/scm/git/',
  );
  const versions = [...index.matchAll(/git-(\d+\.\d+\.\d+)\.tar\.xz/g)].map(
    (match) => match[1]!,
  );
  versions.sort((left, right) =>
    left.localeCompare(right, 'en', { numeric: true }),
  );
  const version = versions.at(-1);
  if (!version) {
    throw new Error('Git release was not found');
  }
  const prefix = `${directory}/tools/git-${version}`;
  if (await useInstalledGit(prefix, version)) {
    return;
  }
  const archive = `git-${version}.tar.xz`;
  await download(
    `https://mirrors.edge.kernel.org/pub/software/scm/git/${archive}`,
    archive,
  );
  const source = join(temporary, 'git-source');
  await mkdir(source);
  await run('/usr/bin/tar', [
    '-xJf',
    join(temporary, archive),
    '-C',
    source,
    '--strip-components=1',
  ]);
  const processors = await run('/usr/bin/nproc', [], true);
  await run('/usr/bin/make', [
    '-C',
    source,
    '-j',
    processors.trim(),
    `prefix=${prefix}`,
    'NO_TCLTK=YesPlease',
    'NO_RUST=YesPlease',
    'all',
  ]);
  await run('/usr/bin/make', [
    '-C',
    source,
    `prefix=${prefix}`,
    'NO_TCLTK=YesPlease',
    'NO_RUST=YesPlease',
    'install',
  ]);
  await link(prefix, `${directory}/tools/git`);
  await link(`${directory}/tools/git/bin/git`, '/usr/local/bin/git');
}

/**
 * installs one supported architecture-specific GitHub release binary
 * @param repository official release repository
 * @param tool managed binary
 */
async function installRelease(
  repository: string,
  tool: 'jj' | 'gh',
): Promise<void> {
  const release: unknown = JSON.parse(
    await downloadText(
      `https://api.github.com/repos/${repository}/releases/latest`,
    ),
  );
  if (
    !isRecord(release) ||
    typeof release.tag_name !== 'string' ||
    !/^v?\d+\.\d+\.\d+$/.test(release.tag_name) ||
    !Array.isArray(release.assets)
  ) {
    throw new Error('Tool release metadata is invalid');
  }
  const version = release.tag_name.replace(/^v/, '');
  const arch =
    process.arch === 'arm64'
      ? tool === 'jj'
        ? 'aarch64'
        : 'arm64'
      : tool === 'jj'
        ? 'x86_64'
        : 'amd64';
  const archive =
    tool === 'jj'
      ? `jj-${release.tag_name}-${arch}-unknown-linux-musl.tar.gz`
      : `gh_${version}_linux_${arch}.tar.gz`;
  const asset = release.assets
    .filter(isRecord)
    .find((entry) => entry.name === archive);
  if (typeof asset?.browser_download_url !== 'string') {
    throw new Error(`Missing ${tool} release asset`);
  }
  await download(asset.browser_download_url, archive);
  await run('/usr/bin/tar', [
    '-xzf',
    join(temporary, archive),
    '-C',
    temporary,
  ]);
  const source =
    tool === 'jj'
      ? join(temporary, 'jj')
      : join(temporary, `gh_${version}_linux_${arch}/bin/gh`);
  await run('/usr/bin/install', [
    '-m',
    '0755',
    source,
    `${directory}/tools/${tool}`,
  ]);
  await link(`${directory}/tools/${tool}`, `/usr/local/bin/${tool}`);
}

/** installs the official stable Tailscale archive for this guest architecture */
async function installTailscale(): Promise<void> {
  const release: unknown = JSON.parse(
    await downloadText('https://pkgs.tailscale.com/stable/?mode=json'),
  );
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const archive =
    isRecord(release) && isRecord(release.Tarballs)
      ? release.Tarballs[arch]
      : undefined;
  if (
    typeof archive !== 'string' ||
    !/^tailscale_[a-zA-Z0-9_.-]+\.tgz$/.test(archive)
  ) {
    throw new Error('Tailscale release metadata is invalid');
  }
  await download(
    `https://pkgs.tailscale.com/stable/${archive}`,
    'tailscale.tgz',
  );
  await run('/usr/bin/tar', [
    '-xzf',
    join(temporary, 'tailscale.tgz'),
    '-C',
    temporary,
  ]);
  const extracted = (await readdir(temporary)).find((name) =>
    name.startsWith('tailscale_'),
  );
  if (!extracted) {
    throw new Error('Tailscale archive is incomplete');
  }
  for (const tool of ['tailscale', 'tailscaled']) {
    await run('/usr/bin/install', [
      '-m',
      '0755',
      join(temporary, extracted, tool),
      `${directory}/tools/${tool}`,
    ]);
    await link(`${directory}/tools/${tool}`, `/usr/local/bin/${tool}`);
  }
}

/** installs and verifies harnesses only as their unprivileged owning account */
async function installHarnesses(): Promise<void> {
  for (const path of [
    `${home}/.local`,
    `${home}/.config`,
    `${home}/.config/agent-sprite`,
  ]) {
    await run('/usr/sbin/runuser', [
      '-u',
      'agent',
      '--',
      `${directory}/node/bin/node`,
      `${directory}/native-files.js`,
      'mkdir',
      home,
      path,
    ]);
  }
  await run('/usr/sbin/runuser', [
    '-u',
    'agent',
    '--',
    '/usr/bin/env',
    `PATH=${directory}/node/bin:${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    `${directory}/node/bin/npm`,
    'install',
    '--global',
    '--prefix',
    `${home}/.local`,
    '@anthropic-ai/claude-code@latest',
    '@openai/codex@latest',
    't3@latest',
    'bun@latest',
    'ws@latest',
  ]);
  await mkdir(`${directory}/node_modules`, { recursive: true, mode: 0o755 });
  await link(
    `${home}/.local/lib/node_modules/ws`,
    `${directory}/node_modules/ws`,
  );
  await verifyTools();
}

/** probes every installed tool as the native account */
async function verifyTools(): Promise<void> {
  for (const [executable, argument] of [
    [`${directory}/node/bin/node`, '--version'],
    ...['git', 'jj', 'gh'].map((tool) => [
      `/usr/local/bin/${tool}`,
      '--version',
    ]),
    ['/usr/local/bin/tailscale', 'version'],
    ...['claude', 'codex', 't3', 'bun'].map((tool) => [
      `${home}/.local/bin/${tool}`,
      '--version',
    ]),
  ]) {
    await run('/usr/sbin/runuser', [
      '-u',
      'agent',
      '--',
      '/usr/bin/env',
      `PATH=${directory}/node/bin:/usr/local/bin:/usr/bin:/bin`,
      executable!,
      argument!,
    ]);
  }
}

/**
 * retains an already-installed current Git version without rebuilding it
 * @param prefix expected versioned installation path
 * @param version current stable version
 * @returns whether a verified installation was reused
 */
async function useInstalledGit(
  prefix: string,
  version: string,
): Promise<boolean> {
  try {
    await access(`${prefix}/bin/git`);
    if (
      (
        await run(
          '/usr/sbin/runuser',
          ['-u', 'agent', '--', `${prefix}/bin/git`, '--version'],
          true,
        )
      ).trim() === `git version ${version}`
    ) {
      await link(prefix, `${directory}/tools/git`);
      await link(`${directory}/tools/git/bin/git`, '/usr/local/bin/git');

      return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  return false;
}
