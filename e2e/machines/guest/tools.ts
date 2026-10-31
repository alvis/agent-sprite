import { harnessDrivers } from '#application/catalog/harnesses';
import { networkDriver } from '#application/catalog/networks';
import { registry } from '#composition/registry';

import { HOMEBREW } from '../layout';

import {
  asAgentWithNode,
  asRoot,
  asRootDetached,
  HOMEBREW_NODE,
  NPM_PREFIX,
} from './execution';

import type { WorkstationProfile } from '#domain/profile';
import type { ToolSpec } from '#domain/tools';

import type { MachineProvider } from '../providers';

/** what an update must leave untouched when every tool is current */
export interface ToolState {
  /** file count and checksum of the listing of the Homebrew kegs with inodes and modification times */
  kegs: string;
  /** the links in the system tool directory with inodes, modification times and targets */
  binLinks: string;
  /** the manifests of the agent's npm packages with inodes and modification times */
  manifests: string;
}

/** the release a component was moved back to and the release it came from */
export interface OlderRelease {
  /** the release now installed, the highest one below the latest */
  older: string;
  /** the latest release when the older one was installed */
  latest: string;
}

/** tool whose link the e2e update removes: a bottled tool no service uses */
export const STALE_COMPONENT = 'jj';

const STALE_BINARY = `/usr/local/bin/${STALE_COMPONENT}`;

/** a dotted release version, one word of a version probe's output */
export const DOTTED_VERSION = /^\d+\.\d+\.\d+$/;

/** prefix on the tool state's Homebrew keg summary */
export const KEGS_PREFIX = 'kegs ';

/**
 * picks the highest plain release below `latest`: it prints `<older> <latest>`
 * and nothing else, since npm's warnings and notices on stderr would otherwise
 * reach the detached script's combined output ahead of it
 */
export const OLDER_RELEASE = [
  "const { execFileSync } = require('node:child_process');",
  'const [npm, name] = process.argv.slice(2);',
  "const view = (args) => execFileSync(npm, ['view', ...args], { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] }).toString();",
  "const latest = view([name + '@latest', 'version']).trim();",
  "const parts = (version) => version.split('.').map(Number);",
  'const compare = (a, b) => { const [x, y] = [parts(a), parts(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };',
  "const releases = JSON.parse(view([name, 'versions', '--json']))",
  '  .filter((version) => /^\\d+\\.\\d+\\.\\d+$/.test(version) && compare(version, latest) < 0).sort(compare);',
  "process.stdout.write(releases.at(-1) + ' ' + latest);",
].join('\n');

/**
 * removes one tool's link, so an update must repair what is missing and not
 * only upgrade what is there
 * @param provider selected provider
 * @param name exact workstation name
 */
export async function removeToolLink(
  provider: MachineProvider,
  name: string,
): Promise<void> {
  await asRoot(
    provider,
    name,
    `set -e; rm -f ${STALE_BINARY}; ! test -e ${STALE_BINARY}`,
  );
}

/**
 * runs the stale component's own version probe in the guest
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the probe's output, which only a linked binary can produce
 */
export async function probeStaleComponent(
  provider: MachineProvider,
  name: string,
): Promise<string> {
  return (await provider.execute(name, `${STALE_BINARY} --version`)).trim();
}

/**
 * lists the tools a workstation of this profile installs for its drivers,
 * beside the base tools every workstation has
 * @param profile selected agent, harnesses and network
 * @returns tool names, sorted
 */
export function profileTools(
  profile: Pick<WorkstationProfile, 'agent' | 'harnesses' | 'network'>,
): string[] {
  const agent = registry.agents[profile.agent];
  const tools: ToolSpec[] = [
    ...networkDriver(registry, profile.network).tools,
    ...harnessDrivers(registry, profile.harnesses).flatMap(
      ({ tools, acpAdapter }) => [
        ...tools,
        ...(acpAdapter ? [acpAdapter.tool] : []),
      ],
    ),
    ...agent.tools,
  ];

  return [...new Set(tools.map(({ name }) => name))].sort();
}

/**
 * reads the facts that change when an update installs, links or builds anything
 * @param provider selected provider
 * @param name exact workstation name
 * @returns a fingerprint of the kegs, the system links and the npm manifests
 */
export async function readToolState(
  provider: MachineProvider,
  name: string,
): Promise<ToolState> {
  const section = (title: string, listing: string): string =>
    `echo "${title}"; ${listing} | sort; echo "end"`;
  const output = await provider.execute(
    name,
    [
      'set -e',
      `listing="$(find ${HOMEBREW.prefix}/Cellar -mindepth 2 -maxdepth 2 -printf '%p %i %T@\\n' | sort)"`,
      `echo "kegs $(printf '%s\\n' "$listing" | wc -l) $(printf '%s\\n' "$listing" | sha256sum | cut -d' ' -f1)"`,
      section(
        'bin',
        `find /usr/local/bin -maxdepth 1 -type l -printf '%p %i %T@ %l\\n'`,
      ),
      section(
        'npm',
        `find ${NPM_PREFIX}/lib/node_modules -mindepth 2 -maxdepth 3 -name package.json -printf '%p %i %T@ %s\\n'`,
      ),
    ].join('; '),
  );
  const lines = output.split('\n').filter(Boolean);
  const between = (title: string): string =>
    lines
      .slice(
        lines.indexOf(title) + 1,
        lines.indexOf('end', lines.indexOf(title)),
      )
      .join('\n');

  return {
    kegs: lines
      .find((line) => line.startsWith(KEGS_PREFIX))!
      .slice(KEGS_PREFIX.length),
    binLinks: between('bin'),
    manifests: between('npm'),
  };
}

/**
 * installs the release just below the latest of an npm component under the
 * agent account, through the guest's own npm and prefix, so the component is
 * genuinely out of date, as on a guest that last updated before that release
 * @param provider selected provider
 * @param name exact workstation name
 * @param tool the component's tool declaration, whose first source must be npm
 * @returns the release installed and the latest one
 */
export async function installOlderRelease(
  provider: MachineProvider,
  name: string,
  tool: ToolSpec,
): Promise<OlderRelease> {
  const [source] = tool.sources;
  if (source.kind !== 'npm') {
    throw new Error(`${tool.name} is not installed from npm`);
  }
  const { package: npmPackage } = source;
  const npm = `${HOMEBREW_NODE}/npm`;
  const picked = await asRootDetached(
    provider,
    name,
    [
      'set -e',
      'script=$(mktemp)',
      `echo ${Buffer.from(OLDER_RELEASE).toString('base64')} | base64 -d > "$script"`,
      'chmod 644 "$script"',
      asAgentWithNode(`${HOMEBREW_NODE}/node "$script" ${npm} ${npmPackage}`),
      'rm -f "$script"',
    ].join('\n'),
  );
  const [older, latest] = picked.trim().split(' ');
  if (!older || older === 'undefined' || !latest) {
    throw new Error(`No release of ${npmPackage} below its latest`);
  }
  await asRootDetached(
    provider,
    name,
    asAgentWithNode(
      `${npm} install --global --no-audit --no-fund ${npmPackage}@${older}`,
    ),
  );

  return { older, latest };
}

/**
 * reads the version a program reports in a fresh login shell of the agent
 * account, as a new harness session sees it
 * @param provider selected provider
 * @param name exact workstation name
 * @param program program name the agent's PATH resolves
 * @returns the dotted version it reports
 */
export async function readLoginVersion(
  provider: MachineProvider,
  name: string,
  program: string,
): Promise<string | undefined> {
  const output = await asRoot(
    provider,
    name,
    `runuser -l agent -c '${program} --version'`,
  );

  return output.split(/\s/).find((word) => DOTTED_VERSION.test(word));
}
