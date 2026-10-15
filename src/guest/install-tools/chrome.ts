import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { CHROME } from '../chrome.js';
import { CHROME_PROBE } from '../system-probes.js';

import { runAsAgent } from './agent.js';

import type { ReleaseInstallTools } from '../../drivers/install-sources.js';

import type { ComponentInstall, ResolvedRelease } from './ledger.js';

/** the stable package Google's repository lists for this guest architecture */
interface ChromeRelease extends ResolvedRelease {
  /** the package's path under the repository */
  filename: string;
  /** the package's SHA-256, in hex, as the repository's index lists it */
  sha256: string;
  /** the package's dependencies, in Debian's relation syntax */
  depends: string;
}

const VERSION = /\d{1,9}\.\d{1,9}\.\d{1,9}\.\d{1,9}/u;
const PACKAGE_VERSION = /^(\d{1,9}\.\d{1,9}\.\d{1,9}\.\d{1,9})-\d{1,9}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
// one dependency: a package name, an optional architecture qualifier and an
// optional version constraint; nothing apt could read as an option
const RELATION =
  '[a-z0-9][a-z0-9.+-]*(?::[a-z0-9]+)?(?: \\((?:>=|<=|>>|<<|=) [0-9A-Za-z.+~:-]+\\))?';
const ALTERNATIVES = `${RELATION}(?: \\| ${RELATION})*`;
const RELATIONS = new RegExp(`^${ALTERNATIVES}(?:, ${ALTERNATIVES})*$`, 'u');
/** the leading digest characters that tell two packages of one version apart */
const DIGEST_PREFIX_LENGTH = 16;
/** permission bits that would let an account other than root change a directory */
const WRITABLE_BY_OTHERS = 0o022;
/** a root-owned directory every account may read and enter */
const OPEN_DIRECTORY_MODE = 0o755;
const ARCHIVE = 'google-chrome.deb';

/**
 * describes Google Chrome's stable package, unpacked under the guest root and
 * linked as `google-chrome`. The version and the package's digest come from
 * the index of Google's apt repository over HTTPS, so the download is checked
 * against the same index apt itself would read; the index's signature is not
 * verified, so the digest guards against a corrupt or mismatched download and
 * the transport against anyone but Google's own servers. Its libraries are
 * installed from the distro with `apt-get satisfy` once the download is
 * verified, so the package's own relations decide which distro packages it
 * needs. Each package unpacks into a directory of its own that is never
 * overwritten, and the package a running browser may still read from is kept
 * until the next update, since an update never stops what the agent runs
 * @param tools installer helpers core lends
 * @returns how the ledger resolves, probes and installs Chrome
 */
export function chromeComponent(
  tools: ReleaseInstallTools,
): ComponentInstall<ChromeRelease> {
  return {
    component: CHROME.component,
    resolve: async () =>
      releaseOf(
        await tools.downloadText(new URL(indexPath(), CHROME.repository).href),
      ),
    // the linked launcher, read as the agent that uses it; a Chrome from
    // anywhere but the managed directory is not this component
    installed: async () =>
      (await linkedRelease()) === undefined
        ? undefined
        : probe(tools, CHROME_PROBE),
    install: async (release) => {
      await tools.download(
        new URL(release.filename, CHROME.repository).href,
        ARCHIVE,
      );
      const archive = join(tools.temporary, ARCHIVE);
      if ((await sha256Of(archive)) !== release.sha256) {
        throw new Error(
          `${CHROME.package} ${release.version} does not match its digest`,
        );
      }
      await tools.run('/usr/bin/apt-get', [
        'satisfy',
        '-y',
        '-qq',
        '--no-install-recommends',
        release.depends,
      ]);
      await mkdir(CHROME.directory, {
        recursive: true,
        mode: OPEN_DIRECTORY_MODE,
      });
      await assertRootOwned(CHROME.directory);
      const previous = await linkedRelease();
      const name = `${release.version}-${release.sha256.slice(0, DIGEST_PREFIX_LENGTH)}`;
      const target = join(CHROME.directory, name);
      if (!(await exists(target))) {
        await unpack(tools, release.version, target);
      }
      await tools.link(join(target, CHROME.launcher), CHROME.command);
      await prune([name, ...(previous ? [previous] : [])]);
    },
  };
}

/**
 * names the repository index of this guest architecture's packages
 * @returns the index's path under the repository
 */
function indexPath(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';

  return `dists/stable/main/binary-${arch}/Packages`;
}

/**
 * reads the stable package's entry from the repository's index
 * @param index the index's text, one blank-line-separated stanza per package
 * @returns the package's version, path, digest and dependencies
 * @throws {Error} when the index lists no valid stable package
 */
function releaseOf(index: string): ChromeRelease {
  const stanza = index
    .split(/\n\s*\n/u)
    .map(fieldsOf)
    .find((fields) => fields.get('Package') === CHROME.package);
  const packageVersion = stanza?.get('Version') ?? '';
  const version = PACKAGE_VERSION.exec(packageVersion)?.[1];
  const filename = stanza?.get('Filename') ?? '';
  const sha256 = stanza?.get('SHA256') ?? '';
  const depends = stanza?.get('Depends') ?? '';
  // the path must name the very version the stanza lists
  const expectedFilename = new RegExp(
    `^pool/main/g/${CHROME.package}/${CHROME.package}_${packageVersion.replaceAll('.', '\\.')}_(?:amd64|arm64)\\.deb$`,
    'u',
  );
  if (
    version === undefined ||
    !expectedFilename.test(filename) ||
    !SHA256.test(sha256) ||
    !RELATIONS.test(depends)
  ) {
    throw new Error(`Google's repository lists no valid ${CHROME.package}`);
  }

  return { version, filename, sha256, depends };
}

/**
 * reads the single-line fields of one index stanza
 * @param stanza the stanza's text
 * @returns each field's value by name
 */
function fieldsOf(stanza: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of stanza.split('\n')) {
    const separator = line.indexOf(': ');
    if (separator > 0 && !/^\s/u.test(line)) {
      fields.set(line.slice(0, separator), line.slice(separator + 2).trim());
    }
  }

  return fields;
}

/**
 * unpacks a verified package beside its final directory and renames it into
 * place only once its browser runs, so a partial or broken unpack is never
 * linked
 * @param tools installer helpers core lends, whose private directory holds the verified package
 * @param version the version the unpacked browser must report
 * @param target the package's final directory
 * @throws {Error} when the unpacked browser does not report the version
 */
async function unpack(
  tools: ReleaseInstallTools,
  version: string,
  target: string,
): Promise<void> {
  const archive = join(tools.temporary, ARCHIVE);
  const staging = join(CHROME.directory, '.staging');
  await rm(staging, { recursive: true, force: true });
  await tools.run('/usr/bin/dpkg-deb', ['--extract', archive, staging]);
  // dpkg-deb creates the root under the installer's umask, which would keep
  // the agent out; every directory inside keeps the package's own mode
  await chmod(staging, OPEN_DIRECTORY_MODE);
  const reported = await probe(tools, [
    join(staging, CHROME.launcher),
    '--version',
  ]);
  if (reported !== version) {
    throw new Error(
      `${CHROME.package} ${version} unpacked reports ${reported ?? 'no version'}`,
    );
  }
  await rename(staging, target);
}

/**
 * runs a version probe as the agent account
 * @param tools installer helpers core lends
 * @param command the browser and its arguments
 * @returns the four-part version the browser reports, or nothing when it does not run
 */
async function probe(
  tools: ReleaseInstallTools,
  command: readonly string[],
): Promise<string | undefined> {
  try {
    return VERSION.exec(
      await runAsAgent(tools.run, command, { capture: true }),
    )?.[0];
  } catch {
    return undefined;
  }
}

/**
 * refuses a directory that is a link, or that an account other than root
 * owns or may change, since root unpacks, renames and removes inside it
 * @param path the directory
 * @throws {Error} when the directory is not a real root-owned directory closed to other accounts
 */
async function assertRootOwned(path: string): Promise<void> {
  const stats = await lstat(path);
  if (
    !stats.isDirectory() ||
    stats.uid !== 0 ||
    (stats.mode & WRITABLE_BY_OTHERS) !== 0
  ) {
    throw new Error(`${path} is not a root-owned directory`);
  }
}

/**
 * reads which unpacked package the linked command runs, which is managed only
 * while it resolves into the managed directory
 * @returns the package directory the link resolves into, or nothing when it resolves nowhere managed
 */
async function linkedRelease(): Promise<string | undefined> {
  const [resolved, directory] = await Promise.all([
    realpath(CHROME.command).catch(() => undefined),
    realpath(CHROME.directory).catch(() => undefined),
  ]);
  if (directory === undefined || !resolved?.startsWith(`${directory}/`)) {
    return undefined;
  }

  return resolved.slice(directory.length + 1).split('/')[0];
}

/**
 * tells whether a path exists, without following a final link
 * @param path where to look
 * @returns whether anything is there
 */
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/**
 * removes every unpacked package but those kept, including any staging
 * directory a stopped run left behind
 * @param kept the package directories to keep
 */
async function prune(kept: readonly string[]): Promise<void> {
  for (const entry of await readdir(CHROME.directory)) {
    if (!kept.includes(entry)) {
      await rm(join(CHROME.directory, entry), { recursive: true, force: true });
    }
  }
}

/**
 * computes a downloaded file's SHA-256 as it streams from disk
 * @param path the file
 * @returns the digest, in hex
 */
async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);

  return hash.digest('hex');
}
