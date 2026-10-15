import { AGENT_HOME, GUEST_ROOT } from '../guest-root.js';

import { AGENT_PATH, probeVersion, runAsAgent } from './agent.js';

import type { ReleaseInstallTools } from '../../drivers/install-sources.js';

import type { ComponentInstall, ResolvedRelease } from './ledger.js';

/** an npm package installed globally under the agent account */
export interface NpmPackage {
  /** key recorded for the package in the install outcomes */
  component: string;
  /** registry package name */
  package: string;
  /** dist-tag whose version is installed; a package without one follows `latest` */
  distTag?: string;
  /** program and arguments that must run for the package to count as installed; a package without one is judged by its manifest alone */
  probe?: readonly string[];
}

const NPM = `${GUEST_ROOT}/node/bin/npm`;
const NODE = `${GUEST_ROOT}/node/bin/node`;
const PREFIX = `${AGENT_HOME}/.local`;
// npm is open-agent's own and runs on its private Node, which the packages'
// install scripts find first; the agent's own sessions do not have it
const NPM_PATH = `${GUEST_ROOT}/node/bin:${AGENT_PATH}`;
const READ_VERSION =
  "console.log(JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).version)";
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * describes an npm package that follows one dist-tag, `latest` unless it names
 * another
 * @param tools installer helpers core lends
 * @param entry the package and the program that proves it runs
 * @returns how the ledger resolves, probes and installs the package
 */
export function npmComponent(
  tools: ReleaseInstallTools,
  entry: NpmPackage,
): ComponentInstall<ResolvedRelease> {
  return {
    component: entry.component,
    resolve: async () => ({
      version: await taggedVersion(tools, entry),
    }),
    installed: async () => installedVersion(tools, entry),
    install: async ({ version }) => {
      await runAsAgent(
        tools.run,
        [
          NPM,
          'install',
          '--global',
          '--prefix',
          PREFIX,
          `${entry.package}@${version}`,
        ],
        { path: NPM_PATH },
      );
    },
  };
}

/**
 * reads the exact version in the installed package's own manifest, so a
 * prerelease is told apart from its final release; the package's program must
 * also run, because a manifest alone does not show a working install
 * @param tools installer helpers core lends
 * @param entry the package and the program that proves it runs
 * @returns the exact installed version, or nothing when the package is absent, unreadable or broken
 */
async function installedVersion(
  tools: ReleaseInstallTools,
  entry: NpmPackage,
): Promise<string | undefined> {
  let version: string;
  try {
    version = (
      await runAsAgent(
        tools.run,
        [
          NODE,
          '-e',
          READ_VERSION,
          `${PREFIX}/lib/node_modules/${entry.package}/package.json`,
        ],
        { capture: true },
      )
    ).trim();
  } catch {
    return undefined;
  }
  if (!RELEASE_VERSION.test(version)) {
    return undefined;
  }
  if (
    entry.probe &&
    (await probeVersion(tools.run, entry.probe)) === undefined
  ) {
    return undefined;
  }

  return version;
}

/**
 * reads the version the registry publishes under the package's dist-tag
 * @param tools installer helpers core lends
 * @param entry the package and the dist-tag it follows
 * @returns the dotted version
 * @throws {Error} when the registry reports none
 */
async function taggedVersion(
  tools: ReleaseInstallTools,
  entry: NpmPackage,
): Promise<string> {
  const tag = entry.distTag ?? 'latest';
  const output = await runAsAgent(
    tools.run,
    [NPM, 'view', `${entry.package}@${tag}`, 'version'],
    { capture: true, path: NPM_PATH },
  );
  const version = output.trim();
  if (!RELEASE_VERSION.test(version)) {
    throw new Error(
      `The ${tag} version of ${entry.package} is not a release version`,
    );
  }

  return version;
}
