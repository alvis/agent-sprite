import { catalog } from '#core/catalog';
import { harnessDrivers } from '#core/harnesses';
import { networkDriver } from '#core/networks';
import { CLAUDE_SETTINGS } from '#drivers/harnesses/claude/paths';
import { CODEX_HOOKS } from '#drivers/harnesses/codex/paths';
import { AWAKE_COMMAND } from '#integrations/guest/awake';
import { parseEnvironment } from '#integrations/guest/environment/contracts';
import {
  AGENT_HOME,
  ENVIRONMENT_PATH,
  GUEST_ROOT,
  SESSION_LOCK,
  UPDATE_LOG,
  UPDATE_STATUS_PATH,
} from '#integrations/guest/layout';
import { parseUpdateStatus, UPDATE_JOB } from '#integrations/guest/updates';

import {
  AWAKE_DIRECTORY,
  GOVERNOR_REPORT,
  HOMEBREW,
  MANAGED_AWAKE_DIRECTORY,
  reportedGovernorState,
} from './layout';

import type { WorkstationProfile } from '#core/profile';
import type { GuestEnvironment } from '#integrations/guest/environment/contracts';
import type { UpdateStatus } from '#integrations/guest/updates';
import type { ToolSpec } from '#tools/contracts';

import type { MachineProvider } from './providers';

/** what one run of the scheduled entry did */
export interface ScheduledRun {
  /** exit status of the entry, the line cron runs */
  exitStatus: number;
  /** whether an update ran meanwhile, which moves the recorded start */
  updated: boolean;
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

/** what an update must leave untouched when every tool is current */
export interface ToolState {
  /** file count and checksum of the listing of the Homebrew kegs with inodes and modification times */
  kegs: string;
  /** the links in the system tool directory with inodes, modification times and targets */
  binLinks: string;
  /** the manifests of the agent's npm packages with inodes and modification times */
  manifests: string;
}

/** tool whose link the e2e update removes: a bottled tool no service uses */
export const STALE_COMPONENT = 'jj';
const STALE_BINARY = `/usr/local/bin/${STALE_COMPONENT}`;
const CRON_ENTRY_PATH = '/etc/cron.d/open-agent';
/** the agent's npm prefix and Homebrew's Node, which the agent's npm tools run on */
const NPM_PREFIX = `${AGENT_HOME}/.local`;
const HOMEBREW_NODE = `${HOMEBREW.prefix}/opt/node/bin`;
/** one tool's outcome as the updater logs it */
const LOGGED_OUTCOME = /^(\S+) \((\S+)\): (installed|skipped|failed)\b/;
/** compilers and build tools, as Homebrew formulae, without a version suffix */
const COMPILERS = new Set(['gcc', 'llvm', 'make', 'cmake', 'binutils']);

/**
 * reads the record setup leaves on the guest, straight from the guest
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the validated record
 */
export async function readEnvironment(
  provider: MachineProvider,
  name: string,
): Promise<GuestEnvironment> {
  return parseEnvironment(
    await provider.execute(name, `cat ${ENVIRONMENT_PATH}`),
  );
}

/** what the updater recorded about its last run, with how its links ended */
export interface UpdateRecord extends UpdateStatus {
  /** `restored` or `failed`; absent before the run reached the links */
  links?: string;
}

/**
 * reads what the updater recorded about its last run, straight from the guest
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the record, with no tools before any update ran
 */
export async function readUpdateRecord(
  provider: MachineProvider,
  name: string,
): Promise<UpdateRecord> {
  const text = await provider.execute(
    name,
    `cat ${UPDATE_STATUS_PATH} 2>/dev/null || true`,
  );
  const status = parseUpdateStatus(text) ?? { tools: [] };
  const { links } = (status.startedAt ? JSON.parse(text) : {}) as {
    links?: unknown;
  };

  return typeof links === 'string' ? { ...status, links } : status;
}

/**
 * reads each tool's outcome of the last update run
 * @param status what the updater recorded
 * @returns each tool's outcome by its name
 */
export function updateOutcomes(status: UpdateRecord): Record<string, string> {
  return Object.fromEntries(
    status.tools.map(({ name, outcome }) => [name, outcome]),
  );
}

/** the update intervals the guest records */
export interface StoredIntervals {
  /** days after the last successful update before another is due, as the stored profile holds them */
  updateDueIntervalDays: number;
  /** the same days, as the update gate reads them from the schedule */
  scheduleDueDays: number;
}

/** how long a detached root script may run before the proof gives up on it */
const DETACHED_TIMEOUT_MS = 10 * 60_000;
const DETACHED_POLL_MS = 3_000;
// enough of a failed script's output to name the failure
const DETACHED_OUTPUT_CHARS = 2000;
const LOCK_WAIT_SECONDS = 120;
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
/** how long a harness session may take to start */
const SESSION_TIMEOUT_MS = 10 * 60_000;

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
 * reads the update intervals the guest records, straight from the guest
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the stored profile's due interval and the schedule's
 */
export async function readStoredIntervals(
  provider: MachineProvider,
  name: string,
): Promise<StoredIntervals> {
  const { profile, schedule } = await readEnvironment(provider, name);

  return {
    updateDueIntervalDays: profile.options.updateDueIntervalDays,
    scheduleDueDays: schedule.dueDays,
  };
}

/**
 * rewrites when the updater says the last update succeeded, as root, whose
 * file it is
 * @param provider selected provider
 * @param name exact workstation name
 * @param at the time to record
 */
export async function setLastSuccessfulUpdate(
  provider: MachineProvider,
  name: string,
  at: Date,
): Promise<void> {
  await asRoot(
    provider,
    name,
    [
      'set -e',
      `/usr/bin/jq --arg at '${at.toISOString()}' '.lastSuccess = $at' ${UPDATE_STATUS_PATH} > ${UPDATE_STATUS_PATH}.e2e`,
      `chmod 0644 ${UPDATE_STATUS_PATH}.e2e`,
      `mv -f ${UPDATE_STATUS_PATH}.e2e ${UPDATE_STATUS_PATH}`,
    ].join('\n'),
  );
}

/**
 * runs a script as root in the guest, whose exec account is not root
 * @param provider selected provider
 * @param name exact workstation name
 * @param script shell script to run
 * @returns the script's output
 */
export async function asRoot(
  provider: MachineProvider,
  name: string,
  script: string,
): Promise<string> {
  return provider.execute(
    name,
    `exec /usr/bin/sudo -n /bin/sh -c '${script.replaceAll("'", "'\\''")}'`,
  );
}

/**
 * runs the update gate's line cron holds, without --force, and waits for it
 * to end: it waits for the session lock, which an update holds, to be free,
 * runs the very line cron runs, then waits for the lock again, since cron's
 * own tick may have taken it between the wait and the run and updated in the
 * entry's stead
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the entry's exit status and whether an update ran
 */
export async function runScheduledEntry(
  provider: MachineProvider,
  name: string,
): Promise<ScheduledRun> {
  const before = await readUpdateRecord(provider, name);
  await waitForUpdateLock(provider, name);
  const exitStatus = Number(
    (
      await asRootDetached(
        provider,
        name,
        [
          'set -e',
          // the line under the job's comment, without its schedule and account
          `entry=$(sed -n '/^# ${UPDATE_JOB.name}$/{n;s/^[^ ]* [^ ]* [^ ]* [^ ]* [^ ]* root //p;}' ${CRON_ENTRY_PATH})`,
          'test -n "$entry"',
          'status=0',
          '/bin/sh -c "$entry" || status=$?',
          'echo "$status"',
        ].join('\n'),
      )
    ).trim(),
  );
  await waitForUpdateLock(provider, name);
  const after = await readUpdateRecord(provider, name);

  return { exitStatus, updated: after.startedAt !== before.startedAt };
}

/**
 * waits for no update run to hold the session lock
 * @param provider selected provider
 * @param name exact workstation name
 */
async function waitForUpdateLock(
  provider: MachineProvider,
  name: string,
): Promise<void> {
  await asRootDetached(
    provider,
    name,
    [
      'set -e',
      // nothing has held the lock while it does not exist
      `test -e ${SESSION_LOCK} || exit 0`,
      'waited=0',
      `until /usr/bin/flock -n ${SESSION_LOCK} true; do waited=$((waited + 1)); test "$waited" -lt ${String(LOCK_WAIT_SECONDS)}; sleep 1; done`,
    ].join('\n'),
  );
}

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
 * lists everything under the guest root but the awake directories the agent
 * writes, and the update schedule, with owner, type and mode, as root reads them
 * @param provider selected provider
 * @param name exact workstation name
 * @returns every entry found
 */
export async function guestEntries(
  provider: MachineProvider,
  name: string,
): Promise<GuestEntry[]> {
  const listing = await asRoot(
    provider,
    name,
    `find ${GUEST_ROOT} -path ${GUEST_ROOT}/run -prune -o -printf '%U %y %m %p\\n'; ` +
      // the schedule: the cron entry always exists, as does the lock once
      // an update ran
      `find ${CRON_ENTRY_PATH} -printf '%U %y %m %p\\n'`,
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
 * lists the entries that are not root-owned, are links, or can be written
 * by another account
 * @param entries guest root entries
 * @returns the offending entries
 */
export function exposedEntries(entries: readonly GuestEntry[]): GuestEntry[] {
  const writableByOthers = 0o022;

  return entries.filter(
    ({ uid, type, mode }) =>
      uid !== 0 || type === 'l' || (mode & writableByOthers) !== 0,
  );
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
  const agent = catalog.agents[profile.agent];
  const tools: ToolSpec[] = [
    ...networkDriver(profile.network).tools,
    ...harnessDrivers(profile.harnesses).flatMap(({ tools, acpAdapter }) => [
      ...tools,
      ...(acpAdapter ? [acpAdapter.tool] : []),
    ]),
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
    kegs: lines.find((line) => line.startsWith('kegs '))!.slice(5),
    binLinks: between('bin'),
    manifests: between('npm'),
  };
}

/**
 * reads the log of the last update run, which each run starts anew
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the log lines
 */
export async function readUpdateLog(
  provider: MachineProvider,
  name: string,
): Promise<string[]> {
  return (await asRoot(provider, name, `cat ${UPDATE_LOG}`))
    .split('\n')
    .filter(Boolean);
}

/**
 * reads each tool's outcome as the updater logged it
 * @param log update log lines
 * @returns each tool's outcome by its name
 */
export function loggedOutcomes(log: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    log.flatMap((line) => {
      const [, tool, , outcome] = LOGGED_OUTCOME.exec(line) ?? [];

      return tool && outcome ? [[tool, outcome]] : [];
    }),
  );
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
  /** where the agent's `git`, `jj` and `gh` resolve */
  links: Record<(typeof BREW_TOOLS)[number], string>;
  /** paths under the prefix the agent account can write; must be none */
  agentWritable: string[];
  /** the prefix's owner and mode, and those of the file the brew command links to */
  owners: string[];
  /** compilers or build tools Homebrew installed */
  brewCompilers: string[];
  /** the receipts of kegs Homebrew built rather than poured from a bottle; must be none */
  unbottledKegs: string[];
}

/**
 * reads the workstation's Git and Homebrew as the agent and root see them
 * @param provider selected provider
 * @param name exact workstation name
 * @returns what the guest reports
 */
export async function readHomebrewGit(
  provider: MachineProvider,
  name: string,
): Promise<HomebrewGit> {
  const brew = `cd ${HOMEBREW.home} && runuser -u ${HOMEBREW.account} -- env -i HOME=${HOMEBREW.home} PATH=/usr/bin:/bin HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1 ${HOMEBREW.brew}`;
  const section = async (script: string): Promise<string[]> =>
    (await asRoot(provider, name, script))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  const [keg] = await section(`${brew} list --versions git`);

  return {
    agentVersion: await readLoginVersion(provider, name, 'git'),
    agentGit: (await section("runuser -l agent -c 'command -v git'"))[0],
    kegVersion: keg?.split(/\s/)[1]?.replace(/_\d+$/, ''),
    links: Object.fromEntries(
      await Promise.all(
        BREW_TOOLS.map(async (tool) => [
          tool,
          (
            await section(
              `readlink -f "$(runuser -l agent -c 'command -v ${tool}')"`,
            )
          )[0] ?? '',
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
      (formula) => COMPILERS.has(formula.replace(/@\d+(?:\.\d+)*$/, '')),
    ),
    unbottledKegs: await section(
      `for receipt in ${HOMEBREW.prefix}/Cellar/*/*/INSTALL_RECEIPT.json; do test -e "$receipt" || continue; grep -q '"poured_from_bottle": *true' "$receipt" || echo "$receipt"; done`,
    ),
  };
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
  provider: MachineProvider,
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
  provider: MachineProvider,
  name: string,
  session: string,
): Promise<ManagedHoldCheck> {
  const managed = `${GUEST_ROOT}/${MANAGED_AWAKE_DIRECTORY}`;
  const holder = `--source e2e-root --session ${session}`;
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
    `runuser -u agent -- ${AWAKE_COMMAND} heartbeat --source e2e --session ${session}`,
  );
  const state: unknown = reportedGovernorState(
    await asRoot(provider, name, GOVERNOR_REPORT),
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
  provider: MachineProvider,
  name: string,
  session: string,
): Promise<AwakeStep[]> {
  const steps: AwakeStep[] = [];
  for (const action of ['heartbeat', 'hold-open', 'hold-close']) {
    const status = await asRoot(
      provider,
      name,
      `runuser -u agent -- ${AWAKE_COMMAND} ${action} --source e2e --session ${session}; echo $?`,
    );
    const state: unknown = reportedGovernorState(
      await asRoot(provider, name, GOVERNOR_REPORT),
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
  provider: MachineProvider,
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
  provider: MachineProvider,
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
    const state = reportedGovernorState(
      await asRoot(provider, name, GOVERNOR_REPORT),
    ) as HookState;
    steps.push({
      action,
      exitCode: Number(status.trim()),
      openHolds: state.openHolds,
      deadline: state.deadline,
      lastHeartbeat: state.lastHeartbeat,
      idleTimeoutMinutes: state.idleTimeoutMinutes,
      taskExpiresAt: await provider.readAwakeTask(name),
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
  provider: MachineProvider,
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
    reportedGovernorState(await asRoot(provider, name, GOVERNOR_REPORT)) as {
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
 * runs a root script that may outlast one provider request: it runs detached
 * in the guest, and this waits for its exit status and output
 * @param provider selected provider
 * @param name exact workstation name
 * @param script shell script to run as root
 * @returns the script's output
 * @throws {Error} when the script exits non-zero or does not end in time
 */
async function asRootDetached(
  provider: MachineProvider,
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
 * runs a command as the agent account with the environment npm needs:
 * Homebrew's Node and the agent's npm prefix
 * @param command shell command line
 * @returns a root script that runs it
 */
function asAgentWithNode(command: string): string {
  return `runuser -u agent -- env HOME=${AGENT_HOME} PATH=${HOMEBREW_NODE}:/usr/bin:/bin NPM_CONFIG_PREFIX=${NPM_PREFIX} ${command}`;
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

/**
 * starts a long-lived Codex app-server session as the agent account, the
 * process the ACP agent starts for each Codex session; its input stays open,
 * so it runs until the workstation is deleted
 * @param provider selected provider
 * @param name exact workstation name
 * @returns the session's processes, once its native process runs
 */
export async function startHarnessSession(
  provider: MachineProvider,
  name: string,
): Promise<HarnessProcess[]> {
  await asRoot(
    provider,
    name,
    `runuser -l agent -c 'setsid nohup sh -c "sleep 1000000 | codex app-server" >/dev/null 2>&1 </dev/null &'`,
  );
  const deadline = Date.now() + SESSION_TIMEOUT_MS;
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
  provider: MachineProvider,
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
