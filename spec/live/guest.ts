import { catalog } from '#core/catalog';
import { harnessDrivers } from '#core/harnesses';
import { networkDriver } from '#core/networks';
import { CLAUDE_SETTINGS } from '#drivers/harnesses/claude/paths';
import { CODEX_HOOKS } from '#drivers/harnesses/codex/paths';
import {
  AGENT_HOME,
  GUEST_KERNEL,
  GUEST_NODE,
  GUEST_ROOT,
} from '#guest/guest-root';
import { HOMEBREW } from '#guest/homebrew';
import {
  AWAKE_DIRECTORY,
  GOVERNOR_STATE_FILE,
  MANAGED_AWAKE_DIRECTORY,
} from '#guest/idle/state';
import { UPDATE_LOCK_PATH } from '#guest/update-schedule';
import { AWAKE_COMMAND } from '#integrations/guest/awake';

import type { WorkstationProfile } from '#core/profile';
import type { ComponentOutcome } from '#guest/component-outcome';
import type { ToolSpec } from '#tools/contracts';

import type { LiveProvider } from './providers.js';

/** what the guest records after an update */
export interface GuestManifestState {
  /** versions the last successful update probed */
  installedVersions: Record<string, string>;
  /** what the last install run did to each component */
  componentOutcomes: Record<string, ComponentOutcome>;
  /** when the last update succeeded */
  lastSuccessfulUpdate: string | undefined;
  /** when the last update was attempted */
  lastAttemptedUpdate: string | undefined;
  /** outcome of the last attempted update */
  lastUpdateStatus: string | undefined;
  /** the safe diagnostic of the last failed update */
  lastUpdateError: string | undefined;
  /** why the updater fell back to a default schedule value, when it did */
  lastUpdateDiagnostic: string | undefined;
}

/** one run of the updater that a scheduled entry started */
export interface UpdaterRun {
  /** the script node ran */
  script: string;
  /** the updater's exit code */
  exitCode: number;
}

/** what one run of the scheduled entry did */
export interface ScheduledRun {
  /** exit status of the entry, the line cron runs */
  exitStatus: number;
  /** every updater process the entry started, which a skipped check leaves none of */
  updaterRuns: UpdaterRun[];
}

/** one entry of the guest root tree as the guest reports it */
export interface GuestEntry {
  /** owning uid */
  uid: number;
  /** `find` file type: `f`, `d` or `l` */
  type: string;
  /** permission bits */
  mode: number;
  /** absolute path */
  path: string;
}

/** what an update must leave untouched when every component is current */
export interface ToolState {
  /** target of the managed Node link */
  nodeLink: string;
  /** file count and checksum of the listing of the tools directory with inodes, modification times and sizes */
  tools: string;
  /** the links in the system tool directory with inodes, modification times and targets */
  binLinks: string;
  /** the manifests of the agent's npm packages with inodes and modification times */
  manifests: string;
}

/** the Node trees beside the managed link */
export interface NodeTrees {
  /** target of the managed Node link */
  link: string;
  /** every tree directory in the guest root, sorted */
  trees: string[];
}

/** component the live update makes stale: a bottled tool no service uses */
export const STALE_COMPONENT = 'jj';
/** recorded version no release ever has */
export const STALE_VERSION = '0.0.0-stale';
const MANIFEST_PATH = `${GUEST_ROOT}/manifest.json`;
const NODE = `${GUEST_ROOT}/node/bin/node`;
const STALE_BINARY = `/usr/local/bin/${STALE_COMPONENT}`;
const TOOLS = `${GUEST_ROOT}/tools`;
const INSTALL_LOG = `${GUEST_ROOT}/install-tools.log`;
/** the version an older Node tree claims, which no release is */
const OLDER_NODE = 'v0.0.1';
const OLDER_TREE = 'node-v0.0.1.Older0';
/** links the manager itself creates in the guest root: the Node link, the tools and each tree's bin */
const MANAGED_LINKS = [
  new RegExp(`^${GUEST_ROOT}/node$`),
  new RegExp(`^${GUEST_ROOT}/tools/[^/]+$`),
  new RegExp(`^${GUEST_ROOT}/node-v[^/]+/bin/[^/]+$`),
];
/** lines an install leaves in the log, which a run that finds everything current must not */
const INSTALL_ACTIVITY =
  /^(?:Installing Node .*|Component \S+ is .*; installing .*|Running \/usr\/bin\/(?:tar|install)|Running \/bin\/bash)$/;
const COMPONENT_CURRENT = /^Component (\S+) is current at \S+; skipped$/;
const COMPONENT_DURATION = /^Component (\S+) took (\d+) ms$/;
/** compilers and build tools, as Homebrew formulae or Debian packages, without a version suffix */
const COMPILERS = new Set([
  'gcc',
  'g++',
  'cpp',
  'clang',
  'llvm',
  'make',
  'cmake',
  'binutils',
  'build-essential',
]);

/**
 * reads the manifest the updater maintains, straight from the guest
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the fields an update changes
 */
export async function readManifestState(
  provider: LiveProvider,
  name: string,
): Promise<GuestManifestState> {
  const manifest = JSON.parse(
    await provider.execute(name, `cat ${MANIFEST_PATH}`),
  ) as Partial<GuestManifestState>;

  return {
    installedVersions: manifest.installedVersions ?? {},
    componentOutcomes: manifest.componentOutcomes ?? {},
    lastSuccessfulUpdate: manifest.lastSuccessfulUpdate,
    lastAttemptedUpdate: manifest.lastAttemptedUpdate,
    lastUpdateStatus: manifest.lastUpdateStatus,
    lastUpdateError: manifest.lastUpdateError,
    lastUpdateDiagnostic: manifest.lastUpdateDiagnostic,
  };
}

/** the update intervals the stored profile records */
export interface StoredIntervals {
  /** days after the last successful update before another is due */
  updateDueIntervalDays: number;
}

/** how long a scheduled entry may take before the live proof gives up on it */
const ENTRY_TIMEOUT_MS = 10 * 60_000;
const ENTRY_POLL_MS = 5_000;
const CRON_ENTRY_PATH = '/etc/cron.d/open-agent';
const ENTRY_SCRIPT = '/run/open-agent-live-entry.sh';
const ENTRY_RUNNER = '/run/open-agent-live-runner.sh';
const ENTRY_PROBE = '/run/open-agent-live-probe.js';
const ENTRY_UPDATER_LOG = '/run/open-agent-live-updater.log';
const ENTRY_DONE = '/run/open-agent-live-entry.done';
const REFRESH_PROBE_GRACE_MS = 60_000;
const REFRESH_PROBE_POLL_MS = 2_000;
/** tries before the proof reports a run cron's own tick kept from the updater */
const ENTRY_ATTEMPTS = 3;
const LOCK_WAIT_SECONDS = 120;
/** records, as the updater process ends, which script ran and how it exited */
const PROBE = `process.on('exit', (code) => require('node:fs').appendFileSync('${ENTRY_UPDATER_LOG}', process.argv[1] + ' ' + code + '\\n'));`;
/** runs the entry line with the probe loaded, then records its exit status */
const RUNNER = [
  '#!/bin/sh',
  `NODE_OPTIONS=--require=${ENTRY_PROBE} /bin/sh ${ENTRY_SCRIPT}`,
  `echo $? > ${ENTRY_DONE}.new`,
  `mv -f ${ENTRY_DONE}.new ${ENTRY_DONE}`,
  '',
].join('\n');

/** how long a detached root script may run before the proof gives up on it */
const DETACHED_TIMEOUT_MS = 10 * 60_000;
const DETACHED_POLL_MS = 3_000;
// enough of a failed script's output to name the failure
const DETACHED_OUTPUT_CHARS = 2000;
/** a dotted release version, one word of a version probe's output */
const DOTTED_VERSION = /^\d+\.\d+\.\d+$/;
/** picks the highest plain release below `latest`: it prints `<older> <latest>` */
const OLDER_RELEASE = [
  "const { execFileSync } = require('node:child_process');",
  'const [npm, name] = process.argv.slice(2);',
  "const latest = execFileSync(npm, ['view', name + '@latest', 'version']).toString().trim();",
  "const parts = (version) => version.split('.').map(Number);",
  'const compare = (a, b) => { const [x, y] = [parts(a), parts(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };',
  "const releases = JSON.parse(execFileSync(npm, ['view', name, 'versions', '--json'], { maxBuffer: 1 << 26 }).toString())",
  '  .filter((version) => /^\\d+\\.\\d+\\.\\d+$/.test(version) && compare(version, latest) < 0).sort(compare);',
  "process.stdout.write(releases.at(-1) + ' ' + latest);",
].join('\n');
/** the session process a harness session runs from its release, beside its launchers */
const NATIVE_HARNESS = '/vendor/';

/** the release a component was moved back to and the release it came from */
export interface OlderRelease {
  /** the release now installed, the highest one below the latest */
  older: string;
  /** the latest release when the older one was installed */
  latest: string;
}

/** one process of a running harness session */
export interface HarnessProcess {
  /** process id */
  pid: number;
  /** start time in clock ticks since boot, which a new process with a reused id never shares */
  startTicks: number;
  /** the file the process executes, which ends in ` (deleted)` once an install replaced it */
  executable: string;
}

/**
 * reads the update intervals the stored profile records, straight from the guest
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the recorded intervals
 */
export async function readStoredIntervals(
  provider: LiveProvider,
  name: string,
): Promise<StoredIntervals> {
  const manifest = JSON.parse(
    await provider.execute(name, `cat ${MANIFEST_PATH}`),
  ) as { profile: { options: StoredIntervals } };
  const { updateDueIntervalDays } = manifest.profile.options;

  return { updateDueIntervalDays };
}

/**
 * rewrites when the manifest says the last update succeeded
 * @param provider selected provider
 * @param name exact workstation name
 * @param at the time to record
 */
export async function setLastSuccessfulUpdate(
  provider: LiveProvider,
  name: string,
  at: Date,
): Promise<void> {
  const edit = [
    "const fs = require('node:fs');",
    `const manifest = JSON.parse(fs.readFileSync('${MANIFEST_PATH}', 'utf8'));`,
    `manifest.lastSuccessfulUpdate = '${at.toISOString()}';`,
    `fs.writeFileSync('${MANIFEST_PATH}', JSON.stringify(manifest, null, 2) + '\\n');`,
  ].join(' ');
  await provider.execute(name, `set -e; ${NODE} -e "${edit}"`);
}

/**
 * runs a script as root in the guest, whose exec account is not root
 * @param provider selected provider
 * @param name exact workstation name
 * @param script shell script to run
 * @returns the script's output
 */
export async function asRoot(
  provider: LiveProvider,
  name: string,
  script: string,
): Promise<string> {
  return provider.execute(
    name,
    `exec /usr/bin/sudo -n /bin/sh -c '${script.replaceAll("'", "'\\''")}'`,
  );
}

/**
 * runs the entry cron holds, without --force, and waits for it to end: it
 * waits for cron's lock to be free, then runs the very line cron runs with a
 * probe that records every updater process it starts, so an update that was
 * not due is told apart from an entry that never reached the updater
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the entry's exit status and the updater runs
 */
export async function runScheduledEntry(
  provider: LiveProvider,
  name: string,
): Promise<ScheduledRun> {
  const encode = (text: string): string =>
    Buffer.from(text, 'utf8').toString('base64');
  await asRoot(
    provider,
    name,
    [
      'set -e',
      `entry=$(sed -n 's/^0 \\* \\* \\* \\* root //p' ${CRON_ENTRY_PATH})`,
      'test -n "$entry"',
      `printf '%s\\n' "$entry" > ${ENTRY_SCRIPT}`,
      `echo ${encode(PROBE)} | base64 -d > ${ENTRY_PROBE}`,
      `echo ${encode(RUNNER)} | base64 -d > ${ENTRY_RUNNER}`,
    ].join('\n'),
  );

  let run: ScheduledRun | undefined;
  for (let attempt = 0; attempt < ENTRY_ATTEMPTS; attempt += 1) {
    run = await attemptScheduledEntry(provider, name);
    // cron's own tick can take the lock between the wait and the run, and the
    // entry then ends without an updater; a skipped check still starts one
    if (run.updaterRuns.length > 0) {
      break;
    }
  }

  return run!;
}

/**
 * starts the entry once and waits for it to end
 * @param provider selected provider
 * @param name exact workstation name
 * @returns what the run did
 */
async function attemptScheduledEntry(
  provider: LiveProvider,
  name: string,
): Promise<ScheduledRun> {
  await asRoot(
    provider,
    name,
    [
      'set -e',
      // cron holds the same lock while its own tick runs the entry
      'waited=0',
      `until /usr/bin/flock -n ${UPDATE_LOCK_PATH} true; do waited=$((waited + 1)); test "$waited" -lt ${String(LOCK_WAIT_SECONDS)}; sleep 1; done`,
      `rm -f ${ENTRY_DONE} ${ENTRY_UPDATER_LOG}`,
      // the entry may outlast one provider request, so it runs on its own
      `setsid nohup /bin/sh ${ENTRY_RUNNER} </dev/null >/dev/null 2>&1 &`,
    ].join('\n'),
  );
  const deadline = Date.now() + ENTRY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = (
      await asRoot(provider, name, `cat ${ENTRY_DONE} 2>/dev/null || true`)
    ).trim();
    if (status !== '') {
      return {
        exitStatus: Number(status),
        updaterRuns: (
          await asRoot(
            provider,
            name,
            `cat ${ENTRY_UPDATER_LOG} 2>/dev/null || true`,
          )
        )
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => {
            const [script, exitCode] = line.split(' ');

            return { script: script!, exitCode: Number(exitCode) };
          })
          .filter(({ script }) => script.endsWith('/updater.js')),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, ENTRY_POLL_MS));
  }
  throw new Error('The scheduled update entry did not finish in time');
}

/**
 * makes one component look out of date both in the manifest and on disk, so an
 * update that skips unchanged components still has to reinstall it
 * @param provider selected provider
 * @param name exact workstation name
 */
export async function makeComponentStale(
  provider: LiveProvider,
  name: string,
): Promise<void> {
  const edit = [
    "const fs = require('node:fs');",
    `const manifest = JSON.parse(fs.readFileSync('${MANIFEST_PATH}', 'utf8'));`,
    `manifest.installedVersions['${STALE_COMPONENT}'] = '${STALE_VERSION}';`,
    `fs.writeFileSync('${MANIFEST_PATH}', JSON.stringify(manifest, null, 2) + '\\n');`,
  ].join(' ');
  await provider.execute(
    name,
    `set -e; ${NODE} -e "${edit}"; rm -f ${STALE_BINARY}; ! test -e ${STALE_BINARY}`,
  );
}

/**
 * runs the stale component's own version probe in the guest
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the probe's output, which only an installed binary can produce
 */
export async function probeStaleComponent(
  provider: LiveProvider,
  name: string,
): Promise<string> {
  return (await provider.execute(name, `${STALE_BINARY} --version`)).trim();
}

/**
 * lists the guest root, its code trees, its Node trees, its tools, its seeded
 * data files and its update schedule with owner, type and mode, as the guest itself reports them
 * @param provider selected provider
 * @param name exact workstation name
 * @returns every entry found
 */
export async function guestEntries(
  provider: LiveProvider,
  name: string,
): Promise<GuestEntry[]> {
  const listing = await provider.execute(
    name,
    `find ${GUEST_ROOT} -maxdepth 0 -printf '%U %y %m %p\\n'; ` +
      `find ${GUEST_ROOT}/guest ${GUEST_ROOT}/drivers ${GUEST_ROOT}/components.json ${GUEST_ROOT}/harnesses.json ${GUEST_ROOT}/install-outcomes.json -printf '%U %y %m %p\\n'; ` +
      // the schedule: the cron entry always exists; the lock only once cron
      // has run
      `find ${CRON_ENTRY_PATH} -printf '%U %y %m %p\\n'; ` +
      `find ${UPDATE_LOCK_PATH} -printf '%U %y %m %p\\n' 2>/dev/null; ` +
      `find ${GUEST_ROOT}/node ${GUEST_ROOT}/node-v* ${TOOLS} -maxdepth 2 -printf '%U %y %m %p\\n'`,
  );

  return listing
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [uid, type, mode, ...path] = line.split(' ');

      return {
        uid: Number(uid),
        type: type!,
        mode: Number.parseInt(mode!, 8),
        path: path.join(' '),
      };
    });
}

/**
 * lists the entries that are not root-owned, are links the manager does not
 * create, or can be written by another account
 * @param entries guest root entries
 * @returns the offending entries
 */
export function exposedEntries(entries: readonly GuestEntry[]): GuestEntry[] {
  const writableByOthers = 0o022;

  return entries.filter(({ uid, type, mode, path }) =>
    type === 'l'
      ? uid !== 0 || !MANAGED_LINKS.some((managed) => managed.test(path))
      : uid !== 0 || (mode & writableByOthers) !== 0,
  );
}

/**
 * lists the components a workstation of this profile installs and probes, which
 * the manifest records both as installed versions and as outcomes
 * @param profile selected agent, harnesses and network
 * @returns component keys, sorted
 */
export function expectedComponents(
  profile: Pick<WorkstationProfile, 'agent' | 'harnesses' | 'network'>,
): string[] {
  const agent = catalog.agents[profile.agent];
  const tools: ToolSpec[] = [
    ...networkDriver(profile.network).tools,
    ...harnessDrivers(profile.harnesses).flatMap(({ tools, acpAdapter }) => [
      ...tools,
      ...(acpAdapter ? [acpAdapter.tool] : []),
    ]),
    ...agent.tools,
  ];

  return ['node', 'git', 'jj', 'gh', ...tools.map(({ name }) => name)].sort();
}

/**
 * lists every component an install run records an outcome for: the probed
 * components and the npm packages the agent's guest modules import
 * @param profile selected agent, harnesses and network
 * @returns outcome keys, sorted
 */
export function expectedOutcomes(
  profile: Pick<WorkstationProfile, 'agent' | 'harnesses' | 'network'>,
): string[] {
  return [
    ...expectedComponents(profile),
    ...catalog.agents[profile.agent].guestPackages,
  ].sort();
}

/**
 * reads the facts that change when an update installs, links or builds anything
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the Node link, a fingerprint of the tools directory, the system links and the npm manifests
 */
export async function readToolState(
  provider: LiveProvider,
  name: string,
): Promise<ToolState> {
  const section = (title: string, listing: string): string =>
    `echo "${title}"; ${listing} | sort; echo "end"`;
  const output = await provider.execute(
    name,
    [
      'set -e',
      `echo "link $(readlink ${GUEST_ROOT}/node)"`,
      `listing="$(find ${TOOLS} -printf '%p %y %i %T@ %s %l\\n' | sort)"`,
      `echo "tools $(printf '%s\\n' "$listing" | wc -l) $(printf '%s\\n' "$listing" | sha256sum | cut -d' ' -f1)"`,
      section(
        'bin',
        `find /usr/local/bin -maxdepth 1 -type l -printf '%p %i %T@ %l\\n'`,
      ),
      section(
        'npm',
        `find ${AGENT_HOME}/.local/lib/node_modules -mindepth 2 -maxdepth 3 -name package.json -printf '%p %i %T@ %s\\n'`,
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
    nodeLink: lines.find((line) => line.startsWith('link '))!.slice(5),
    tools: lines.find((line) => line.startsWith('tools '))!.slice(6),
    binLinks: between('bin'),
    manifests: between('npm'),
  };
}

/**
 * reads the install log of the most recent run, which each run starts anew
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the log lines
 */
export async function readInstallLog(
  provider: LiveProvider,
  name: string,
): Promise<string[]> {
  return (await provider.execute(name, `cat ${INSTALL_LOG}`))
    .split('\n')
    .filter(Boolean);
}

/** the tools a workstation pours from Homebrew bottles */
export const BREW_TOOLS = ['git', 'jj', 'gh'] as const;

/** what the workstation's Git and Homebrew look like from the guest */
export interface HomebrewGit {
  /** version `git --version` reports to the agent's login shell */
  agentVersion?: string;
  /** the Git the agent's login shell runs */
  agentGit?: string;
  /** Git's installed keg as Homebrew lists it, without its revision */
  kegVersion?: string;
  /** where `/usr/local/bin/git`, `jj` and `gh` resolve */
  links: Record<(typeof BREW_TOOLS)[number], string>;
  /** paths under the prefix the agent account can write; must be none */
  agentWritable: string[];
  /** the prefix's owner and mode, and those of the file the brew command links to */
  owners: string[];
  /** compilers or build tools Homebrew installed */
  brewCompilers: string[];
  /** compilers, build tools or headers any apt run on the guest installed */
  aptCompilers: string[];
  /** the compilers on the agent's PATH, which only the provider's image can have put there */
  imageCompilers: string[];
}

/**
 * reads the workstation's Git and Homebrew as the agent and root see them
 * @param provider selected provider
 * @param name exact workstation name
 * @returns what the guest reports
 */
export async function readHomebrewGit(
  provider: LiveProvider,
  name: string,
): Promise<HomebrewGit> {
  const brew = `cd ${HOMEBREW.home} && runuser -u ${HOMEBREW.account} -- env -i HOME=${HOMEBREW.home} PATH=/usr/bin:/bin HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1 ${HOMEBREW.brew}`;
  const section = async (script: string): Promise<string[]> =>
    (await asRoot(provider, name, script))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  const [keg] = await section(`${brew} list --versions git`);
  // every apt run open-agent makes passes these flags, which set its runs
  // apart from whatever the provider's image installed when it was built
  const installedByApt = await section(
    "zcat -f /var/log/apt/history.log* 2>/dev/null | awk '/^Commandline:/ { ours = index($0, \"--no-upgrade --no-install-recommends\") > 0 } /^Install:/ && ours { sub(/^Install: /, \"\"); print }' | tr ',' '\\n' | sed 's/^ *//; s/[: ].*//'",
  );

  return {
    agentVersion: await readLoginVersion(provider, name, 'git'),
    agentGit: (await section("runuser -l agent -c 'command -v git'"))[0],
    kegVersion: keg?.split(/\s/)[1]?.replace(/_\d+$/, ''),
    links: Object.fromEntries(
      await Promise.all(
        BREW_TOOLS.map(async (tool) => [
          tool,
          (await section(`readlink -f /usr/local/bin/${tool}`))[0] ?? '',
        ]),
      ),
    ) as HomebrewGit['links'],
    agentWritable: await section(
      `runuser -u agent -- find ${HOMEBREW.home} -writable 2>/dev/null | head -20`,
    ),
    owners: await section(
      `stat -L -c '%U %G %a %n' ${HOMEBREW.home} ${HOMEBREW.prefix} ${HOMEBREW.brew}`,
    ),
    brewCompilers: (await section(`${brew} list --formula -1`)).filter(
      isCompiler,
    ),
    aptCompilers: installedByApt.filter(isCompiler),
    imageCompilers: await section(
      'for tool in gcc cc g++ make; do command -v $tool; done; true',
    ),
  };
}

/**
 * tells whether a Homebrew formula or a Debian package compiles or builds
 * @param name formula or package name
 * @returns whether it is a compiler, a build tool or development headers
 */
function isCompiler(name: string): boolean {
  return (
    COMPILERS.has(name.replace(/[@-]\d+(?:\.\d+)*$/, '')) ||
    name.endsWith('-dev')
  );
}

/**
 * lists how long each bottled tool's step took in an install log
 * @param log install log lines
 * @returns each tool with its step's milliseconds
 */
export function brewToolDurations(log: readonly string[]): string {
  return BREW_TOOLS.map(
    (tool) => `${tool} ${componentDuration(log, tool)} ms`,
  ).join(', ');
}

/**
 * reads how long the run that wrote the log spent on one component
 * @param log install log lines
 * @param component component key
 * @returns the time in milliseconds, or nothing when the log does not say
 */
export function componentDuration(
  log: readonly string[],
  component: string,
): number | undefined {
  for (const line of log) {
    const [, key, ms] = COMPONENT_DURATION.exec(line) ?? [];
    if (key === component && ms !== undefined) {
      return Number(ms);
    }
  }

  return undefined;
}

/**
 * picks the log lines of an install: a Node install, a component install, an
 * archive unpacked, a build or a binary put in place
 * @param log install log lines
 * @returns the lines that show something was installed
 */
export function installActivity(log: readonly string[]): string[] {
  return log.filter((line) => INSTALL_ACTIVITY.test(line));
}

/**
 * lists the components a run found current and left alone
 * @param log install log lines
 * @returns component keys in log order
 */
export function skippedComponents(log: readonly string[]): string[] {
  return log.flatMap((line) => COMPONENT_CURRENT.exec(line)?.[1] ?? []);
}

/**
 * reads the Node link and the tree directories beside it
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the link target and every tree name
 */
export async function readNodeTrees(
  provider: LiveProvider,
  name: string,
): Promise<NodeTrees> {
  const output = await provider.execute(
    name,
    `readlink ${GUEST_ROOT}/node; find ${GUEST_ROOT} -maxdepth 1 -type d -name 'node-v*' -printf '%f\\n' | sort`,
  );
  const [link, ...trees] = output.split('\n').filter(Boolean);

  return { link: link!, trees };
}

/**
 * points the managed Node link at a tree that reports an older version, as a
 * guest does that last updated long ago; the tree runs the real Node
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the name of the older tree and of the tree that was live
 */
export async function placeOlderNode(
  provider: LiveProvider,
  name: string,
): Promise<{ older: string; live: string }> {
  const older = `${GUEST_ROOT}/${OLDER_TREE}`;
  // the exec account is not root, and the updater trusts only root's files, so
  // the whole swap runs as root
  const steps = [
    'set -e',
    'umask 022',
    `live="$(readlink ${GUEST_ROOT}/node)"`,
    `mkdir ${older} ${older}/bin`,
    // reports an older version and otherwise runs the live tree's Node
    `printf '%s\\n' '#!/bin/sh' 'if test "$1" = --version; then echo ${OLDER_NODE}; exit 0; fi' 'exec ${GUEST_ROOT}/'"$live"'/bin/node "$@"' >${older}/bin/node`,
    `chmod 0755 ${older}/bin/node`,
    `for tool in npm npx; do ln -s "${GUEST_ROOT}/$live/bin/$tool" ${older}/bin/$tool; done`,
    `ln -s ${OLDER_TREE} ${GUEST_ROOT}/.node-older`,
    `mv -T ${GUEST_ROOT}/.node-older ${GUEST_ROOT}/node`,
    'echo "$live"',
  ];
  const live = (
    await provider.execute(
      name,
      `sudo -n /bin/sh -s <<'OLDER_NODE'\n${steps.join('\n')}\nOLDER_NODE`,
    )
  ).trim();

  return { older: OLDER_TREE, live };
}

/** who owns the installed awake command and directories, and their modes */
export interface AwakeInstall {
  /** owner and mode of the awake command, as `<user> <mode>` */
  command: string;
  /** owner, group and mode of the shared awake directory, as `<user> <group> <mode>` */
  directory: string;
  /** owner, group and mode of the managed awake directory, as `<user> <group> <mode>` */
  managedDirectory: string;
}

/** what became of a hold root opened after the agent account tried to remove it */
export interface ManagedHoldCheck {
  /** exit status of the agent account's removal */
  removeExitCode: number;
  /** the managed holder files still holding after the removal; closed ones from earlier operations stay until pruned */
  managedHolders: number;
  /** the governor state record after an agent-account heartbeat, as root reads it */
  state: unknown;
}

/** one awake event the agent account sent and the state it left */
export interface AwakeStep {
  /** the command's exit status */
  exitCode: number;
  /** the governor state record after the event, as root reads it */
  state: unknown;
}

/**
 * reads how the awake command and its directories are installed
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the owner and mode of each
 */
export async function readAwakeInstall(
  provider: LiveProvider,
  name: string,
): Promise<AwakeInstall> {
  const [command, directory, managedDirectory] = await Promise.all([
    asRoot(provider, name, `find ${AWAKE_COMMAND} -printf '%u %m'`),
    asRoot(
      provider,
      name,
      `find ${GUEST_ROOT}/${AWAKE_DIRECTORY} -maxdepth 0 -printf '%u %g %m'`,
    ),
    asRoot(
      provider,
      name,
      `find ${GUEST_ROOT}/${MANAGED_AWAKE_DIRECTORY} -maxdepth 0 -printf '%u %g %m'`,
    ),
  ]);

  return { command, directory, managedDirectory };
}

/**
 * opens a hold as root, as a managed operation does, lets the agent account
 * try to remove every managed holder file, and reads the state an
 * agent-account heartbeat then records; the hold is closed after
 * @param provider selected provider
 * @param name exact workstation name
 * @param session the session the events report
 * @returns the removal's exit status, the managed holders left and the state
 */
export async function checkManagedHold(
  provider: LiveProvider,
  name: string,
  session: string,
): Promise<ManagedHoldCheck> {
  const managed = `${GUEST_ROOT}/${MANAGED_AWAKE_DIRECTORY}`;
  const holder = `--source live-root --session ${session}`;
  await asRoot(provider, name, `${AWAKE_COMMAND} hold-open ${holder}`);
  // root's shell expands the names; the agent account then removes them
  const removeExitCode = Number(
    (
      await asRoot(
        provider,
        name,
        `runuser -u agent -- rm -f ${managed}/h-*.json 2>/dev/null; echo $?`,
      )
    ).trim(),
  );
  const managedHolders = Number(
    (
      await asRoot(
        provider,
        name,
        `grep -l holdExpiresAt ${managed}/h-*.json 2>/dev/null | wc -l`,
      )
    ).trim(),
  );
  await asRoot(
    provider,
    name,
    `runuser -u agent -- ${AWAKE_COMMAND} heartbeat --source live --session ${session}`,
  );
  const state: unknown = JSON.parse(
    await asRoot(
      provider,
      name,
      `cat ${GUEST_ROOT}/${AWAKE_DIRECTORY}/${GOVERNOR_STATE_FILE}`,
    ),
  );
  await asRoot(provider, name, `${AWAKE_COMMAND} hold-close ${holder}`);

  return { removeExitCode, managedHolders, state };
}

/**
 * sends a heartbeat, opens a hold and closes it as the agent account, as a
 * harness hook does, reading the governor state after each event
 * @param provider selected provider
 * @param name exact workstation name
 * @param session the session the events report
 * @returns each event's exit status and the state it left
 */
export async function sendAwakeEvents(
  provider: LiveProvider,
  name: string,
  session: string,
): Promise<AwakeStep[]> {
  const steps: AwakeStep[] = [];
  for (const action of ['heartbeat', 'hold-open', 'hold-close']) {
    const status = await asRoot(
      provider,
      name,
      `runuser -u agent -- ${AWAKE_COMMAND} ${action} --source live --session ${session}; echo $?`,
    );
    const state: unknown = JSON.parse(
      await asRoot(
        provider,
        name,
        `cat ${GUEST_ROOT}/${AWAKE_DIRECTORY}/${GOVERNOR_STATE_FILE}`,
      ),
    );
    steps.push({ exitCode: Number(status.trim()), state });
  }

  return steps;
}

/** the awake commands the hook files of the two harnesses list, by event */
export interface AwakeHooks {
  /** Claude Code's settings */
  claude: Record<string, string[]>;
  /** Codex's hooks file */
  codex: Record<string, string[]>;
}

/** one hook event the agent account sent through standard input */
export interface HookStep {
  /** the awake action the hook runs */
  action: string;
  /** the command's exit status */
  exitCode: number;
  /** holds still open after the event */
  openHolds: number;
  /** the deadline the governor records, absent when nothing keeps the workstation awake */
  deadline: string | undefined;
  /** when the governor last saw a heartbeat */
  lastHeartbeat: string | undefined;
  /** idle minutes the governor applies */
  idleTimeoutMinutes: number;
  /** when the Sprite task expires, absent when the Sprite has no task */
  taskExpiresAt: string | undefined;
}

/** the part of the hook file the proof reads */
interface HookFile {
  hooks?: Record<
    string,
    Array<{ hooks?: Array<{ command?: string }> }> | undefined
  >;
}

/**
 * reads the awake hook commands of both harnesses from their files in the guest
 * @param provider selected provider
 * @param name exact workstation name
 * @returns each harness's awake commands by event
 */
export async function readAwakeHooks(
  provider: LiveProvider,
  name: string,
): Promise<AwakeHooks> {
  const read = async (path: string): Promise<Record<string, string[]>> => {
    const file = JSON.parse(
      await asRoot(provider, name, `cat ${path}`),
    ) as HookFile;

    return Object.fromEntries(
      Object.entries(file.hooks ?? {}).map(([event, groups]) => [
        event,
        (groups ?? [])
          .flatMap((group) => group.hooks ?? [])
          .map((hook) => hook.command ?? '')
          .filter((command) => command.startsWith(AWAKE_COMMAND)),
      ]),
    );
  };

  return {
    claude: await read(CLAUDE_SETTINGS),
    codex: await read(CODEX_HOOKS),
  };
}

/** the state fields a hook step reports */
interface HookState {
  openHolds: number;
  deadline?: string;
  lastHeartbeat?: string;
  idleTimeoutMinutes: number;
}

/**
 * reads the Sprite's own task list as the agent account, which reaches the
 * guest-local API socket without a credential
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the expiry of the awake task, absent when there is none
 */
export async function readAwakeTaskExpiry(
  provider: LiveProvider,
  name: string,
): Promise<string | undefined> {
  const reply = JSON.parse(
    await asRoot(
      provider,
      name,
      'runuser -u agent -- curl -s --max-time 5 --unix-socket /.sprite/api.sock http://sprite/v1/tasks',
    ),
  ) as { tasks?: Array<{ name: string; expires_at: string }> };

  return reply.tasks?.find((task) => task.name === 'open-agent-awake')
    ?.expires_at;
}

/**
 * sends each hook event the way a harness does, as the agent account with the
 * event's JSON on standard input, and reads what the governor and the Sprite
 * then hold
 * @param provider selected provider
 * @param name exact workstation name
 * @param events what to send
 * @param events.harness the harness the events come from
 * @param events.session the session the events name
 * @param events.actions the awake actions to send, in order
 * @param events.pausesMs how long to wait before sending an action, by action
 * @returns each event's exit status and the resulting state
 */
export async function sendHookEvents(
  provider: LiveProvider,
  name: string,
  events: {
    harness: string;
    session: string;
    actions: readonly string[];
    pausesMs?: Partial<Record<string, number>>;
  },
): Promise<HookStep[]> {
  const { harness, session, actions, pausesMs = {} } = events;
  const steps: HookStep[] = [];
  const event = JSON.stringify({ session_id: session, hook_event_name: 'x' });
  for (const action of actions) {
    await sleep(pausesMs[action] ?? 0);
    const status = await asRoot(
      provider,
      name,
      `printf '%s' '${event}' | runuser -u agent -- ${AWAKE_COMMAND} ${action} --source ${harness} --session -; echo $?`,
    );
    const state = JSON.parse(
      await asRoot(
        provider,
        name,
        `cat ${GUEST_ROOT}/${AWAKE_DIRECTORY}/${GOVERNOR_STATE_FILE}`,
      ),
    ) as HookState;
    steps.push({
      action,
      exitCode: Number(status.trim()),
      openHolds: state.openHolds,
      deadline: state.deadline,
      lastHeartbeat: state.lastHeartbeat,
      idleTimeoutMinutes: state.idleTimeoutMinutes,
      taskExpiresAt: await readAwakeTaskExpiry(provider, name),
    });
  }

  return steps;
}

/**
 * records which sources hold the workstation awake while an operation runs
 * @param provider selected provider
 * @param name exact workstation name
 * @param operation the operation to watch
 * @returns the operation's result, every holder source seen meanwhile, how
 * many distinct expiries each source's hold showed (a hold that is refreshed
 * shows more than one) and the holds still open once it ended
 */
export async function watchHolders<T>(
  provider: LiveProvider,
  name: string,
  operation: () => Promise<T>,
): Promise<{
  result: T;
  sources: string[];
  expiries: Record<string, number>;
  openHoldsAfter: number;
}> {
  const sources = new Set<string>();
  const expiries = new Map<string, Set<string>>();
  const readState = async (): Promise<{
    holds: Array<{ source: string; expiresAt: string }>;
    openHolds: number;
  }> =>
    JSON.parse(
      await asRoot(
        provider,
        name,
        `cat ${GUEST_ROOT}/${AWAKE_DIRECTORY}/${GOVERNOR_STATE_FILE}`,
      ),
    ) as {
      holds: Array<{ source: string; expiresAt: string }>;
      openHolds: number;
    };
  const watching = { isActive: true };
  const watcher = (async () => {
    while (watching.isActive) {
      for (const { source, expiresAt } of (await readState()).holds) {
        sources.add(source);
        expiries.set(
          source,
          (expiries.get(source) ?? new Set()).add(expiresAt),
        );
      }
    }
  })();
  try {
    const result = await operation();
    watching.isActive = false;
    await watcher;

    return {
      result,
      sources: [...sources].sort(),
      expiries: Object.fromEntries(
        [...expiries].map(([source, seen]) => [source, seen.size]),
      ),
      openHoldsAfter: (await readState()).openHolds,
    };
  } finally {
    watching.isActive = false;
    await watcher;
  }
}

/**
 * waits
 * @param ms how long, in milliseconds; nothing happens for 0
 */
async function sleep(ms: number): Promise<void> {
  if (ms > 0) {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

/**
 * proves a descriptor root holds open does not reach the agent-account child
 * the governor starts: root opens a lock file on descriptor 9 without
 * close-on-exec, as a transaction worker holds its lock, and then runs the
 * guest's own `applyAsAgentAccount` with an entry that reports its user and
 * how many of its descriptors point at that lock file
 * @param provider selected provider
 * @param name exact workstation name
 * @returns what the child reported: `uid=<id> lock-fds=<count>`
 */
export async function checkLockDescriptorInheritance(
  provider: LiveProvider,
  name: string,
): Promise<string> {
  const entry = [
    "import { readdirSync, readlinkSync } from 'node:fs';",
    "const links = readdirSync('/proc/self/fd').flatMap((fd) => {",
    "  try { return [readlinkSync('/proc/self/fd/' + fd)]; } catch { return []; }",
    '});',
    "const locks = links.filter((link) => link.endsWith('/oa-fd.lock'));",
    "process.stdout.write(JSON.stringify({ at: new Date().toISOString(), action: 'apply-deadline', result: 'uid=' + process.getuid() + ' lock-fds=' + locks.length }));",
  ].join('\n');
  const runner = [
    `import { applyAsAgentAccount } from '${GUEST_KERNEL}/idle/agent-apply.js';`,
    "import { execFileSync } from 'node:child_process';",
    "const id = (flag) => Number(execFileSync('/usr/bin/id', [flag, 'agent']).toString());",
    `const result = await applyAsAgentAccount({ entry: process.argv[2], account: { uid: id('-u'), gid: id('-g') }, limitMs: 10000, at: new Date().toISOString() });`,
    'process.stdout.write(result.result ?? result.failure ?? "");',
  ].join('\n');
  const output = await asRoot(
    provider,
    name,
    [
      'set -e',
      'dir=$(mktemp -d)',
      'chmod 755 "$dir"',
      `echo ${Buffer.from(entry).toString('base64')} | base64 -d > "$dir/entry.mjs"`,
      `echo ${Buffer.from(runner).toString('base64')} | base64 -d > "$dir/runner.mjs"`,
      'chmod 644 "$dir/entry.mjs" "$dir/runner.mjs"',
      'exec 9>"$dir/oa-fd.lock"',
      `${GUEST_NODE} "$dir/runner.mjs" "$dir/entry.mjs"`,
      'rm -rf "$dir"',
    ].join('\n'),
  );

  return output.trim();
}

/** source name of the hold the refresh probe opens */
export const REFRESH_PROBE_SOURCE = 'refresh-probe';

/** where the refresh probe leaves its marker once the operation has ended */
const REFRESH_PROBE_DONE = '/run/oa-refresh-probe.done';

/**
 * runs a managed operation longer than half the hold maximum under the guest's
 * own `withAwakeHold`, as root, so the hold must be refreshed to stay open; the
 * operation runs detached because one command may not outlast the provider's
 * command limit, and this waits for it to leave its marker
 * @param provider selected provider
 * @param name exact workstation name
 * @param operationMs how long the operation lasts, in milliseconds
 */
export async function runRefreshProbe(
  provider: LiveProvider,
  name: string,
  operationMs: number,
): Promise<void> {
  const runner = [
    `import { withAwakeHold } from '${GUEST_KERNEL}/idle/hold.js';`,
    `await withAwakeHold({ source: '${REFRESH_PROBE_SOURCE}', session: 'probe' }, async () => new Promise((resolve) => { setTimeout(resolve, ${operationMs}); }));`,
  ].join('\n');
  await asRoot(
    provider,
    name,
    [
      'set -e',
      `rm -f ${REFRESH_PROBE_DONE}`,
      'dir=$(mktemp -d)',
      `echo ${Buffer.from(runner).toString('base64')} | base64 -d > "$dir/probe.mjs"`,
      `(${GUEST_NODE} "$dir/probe.mjs"; rm -rf "$dir"; touch ${REFRESH_PROBE_DONE}) </dev/null >/dev/null 2>&1 &`,
    ].join('\n'),
  );
  const deadline = Date.now() + operationMs + REFRESH_PROBE_GRACE_MS;
  while (Date.now() < deadline) {
    const left = await asRoot(
      provider,
      name,
      `test -e ${REFRESH_PROBE_DONE} && echo done || echo running`,
    );
    if (left.trim() === 'done') {
      return;
    }
    await sleep(REFRESH_PROBE_POLL_MS);
  }
  throw new Error('The refresh probe did not end in time');
}

/**
 * runs a root script that may outlast one provider request: it runs detached
 * in the guest, and this waits for its exit status and output
 * @param provider selected provider
 * @param name exact workstation name
 * @param script shell script to run as root
 * @returns the script's output
 * @throws {Error} when the script exits non-zero or does not end in time
 */
async function asRootDetached(
  provider: LiveProvider,
  name: string,
  script: string,
): Promise<string> {
  const directory = (
    await asRoot(
      provider,
      name,
      [
        'set -e',
        'dir=$(mktemp -d)',
        `echo ${Buffer.from(script).toString('base64')} | base64 -d > "$dir/run.sh"`,
        `setsid nohup /bin/sh -c '/bin/sh "$1/run.sh" > "$1/out" 2>&1; echo $? > "$1/exit.new"; mv "$1/exit.new" "$1/exit"' sh "$dir" </dev/null >/dev/null 2>&1 &`,
        'echo "$dir"',
      ].join('\n'),
    )
  ).trim();
  const deadline = Date.now() + DETACHED_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = (
      await asRoot(provider, name, `cat ${directory}/exit 2>/dev/null || true`)
    ).trim();
    if (status !== '') {
      const output = await asRoot(
        provider,
        name,
        `cat ${directory}/out; rm -rf ${directory}`,
      );
      if (status !== '0') {
        throw new Error(
          `Detached guest script exited ${status}: ${output.slice(-DETACHED_OUTPUT_CHARS)}`,
        );
      }

      return output;
    }
    await sleep(DETACHED_POLL_MS);
  }
  throw new Error('The detached guest script did not end in time');
}

/**
 * runs a command as the agent account with the environment npm needs
 * @param command shell command line
 * @returns a root script that runs it
 */
function asAgentWithNode(command: string): string {
  return `runuser -u agent -- env HOME=${AGENT_HOME} PATH=${GUEST_ROOT}/node/bin:/usr/bin:/bin ${command}`;
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
  provider: LiveProvider,
  name: string,
  tool: ToolSpec,
): Promise<OlderRelease> {
  const [source] = tool.sources;
  if (source.kind !== 'npm') {
    throw new Error(`${tool.name} is not installed from npm`);
  }
  const { package: npmPackage } = source;
  const npm = `${GUEST_ROOT}/node/bin/npm`;
  const picked = await asRootDetached(
    provider,
    name,
    [
      'set -e',
      'script=$(mktemp)',
      `echo ${Buffer.from(OLDER_RELEASE).toString('base64')} | base64 -d > "$script"`,
      'chmod 644 "$script"',
      asAgentWithNode(`${NODE} "$script" ${npm} ${npmPackage}`),
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
      `${npm} install --global --prefix ${AGENT_HOME}/.local --no-audit --no-fund ${npmPackage}@${older}`,
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
  provider: LiveProvider,
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

/**
 * starts a long-lived Codex app-server session as the agent account, the
 * process the ACP agent starts for each Codex session; its input stays open,
 * so it runs until the workstation is deleted
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the session's processes, once its native process runs
 */
export async function startHarnessSession(
  provider: LiveProvider,
  name: string,
): Promise<HarnessProcess[]> {
  await asRoot(
    provider,
    name,
    `runuser -l agent -c 'setsid nohup sh -c "sleep 1000000 | codex app-server" >/dev/null 2>&1 </dev/null &'`,
  );
  const deadline = Date.now() + ENTRY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const processes = await readHarnessSession(provider, name);
    if (
      processes.some(({ executable }) => executable.includes(NATIVE_HARNESS))
    ) {
      return processes;
    }
    await sleep(DETACHED_POLL_MS);
  }
  throw new Error('The harness session did not start in time');
}

/**
 * reads the processes of the running Codex app-server sessions
 * @param provider selected provider
 * @param name exact workstation name
 * @returns every session process, ordered by id
 */
export async function readHarnessSession(
  provider: LiveProvider,
  name: string,
): Promise<HarnessProcess[]> {
  // the agent account reads its own processes' executables, which root here may not
  const listing = await asRoot(
    provider,
    name,
    `for pid in $(pgrep -u agent -f 'codex app-server'); do test -r /proc/$pid/stat && echo "$pid $(cut -d' ' -f22 /proc/$pid/stat) $(runuser -u agent -- readlink /proc/$pid/exe)"; done; true`,
  );

  return listing
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [pid, startTicks, ...executable] = line.split(' ');

      return {
        pid: Number(pid),
        startTicks: Number(startTicks),
        executable: executable.join(' '),
      };
    })
    .sort((a, b) => a.pid - b.pid);
}

/**
 * describes the same session after an install replaced its release: every
 * process keeps its id and start, and the native process keeps running the
 * replaced file
 * @param session the session as it started
 * @param matching the test's own matcher for a string a pattern matches
 * @returns the processes expected afterwards
 */
export function replacedSession(
  session: readonly HarnessProcess[],
  matching: (pattern: RegExp) => unknown,
): Array<Omit<HarnessProcess, 'executable'> & { executable: unknown }> {
  return session.map(({ pid, startTicks, executable }) => ({
    pid,
    startTicks,
    executable: executable.includes(NATIVE_HARNESS)
      ? matching(replacedFile(executable))
      : executable,
  }));
}

/**
 * matches the path a process shows for a file an install replaced
 * @param executable the path while the file was in place
 * @returns a pattern for any replaced file under the same npm prefix
 */
function replacedFile(executable: string): RegExp {
  return new RegExp(
    `^${executable.slice(0, executable.indexOf('/node_modules/')).replaceAll('.', '\\.')}/.* \\(deleted\\)$`,
  );
}
