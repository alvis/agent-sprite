import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { parse } from 'dotenv';
import { execa } from 'execa';
import { describe, inject, it } from 'vitest';

import { catalog } from '#core/catalog';
import { harnessDrivers } from '#core/harnesses';
import { providerPreflight } from '#core/preflight';
import { defaultProfile } from '#core/profile';
import { FlyApi } from '#drivers/providers/fly-machine/api';
import {
  BOOT_LOG,
  BOOT_STATUS,
  BOOT_STEPS,
  PROFILE_PATH,
  ROOTFS_RESTORED,
  VOLUME_LAYOUT,
} from '#drivers/providers/fly-machine/boot-layout';
import {
  decodeToken,
  deriveSshToken,
  FLYCTL,
  flyctlConfigDirectory,
} from '#drivers/providers/fly-machine/flyctl';
import { tokenScopeProblem } from '#drivers/providers/fly-machine/token-scope';
import { summarizeProfile } from '#drivers/providers/recorded';
import { GUEST_ROOT } from '#guest/guest-root';
import { HOMEBREW } from '#guest/homebrew';
import { AWAKE_COMMAND } from '#integrations/guest/awake';
import { isRecord } from '#utilities/guards';

import { createLiveCli, successData } from './cli.js';
import {
  createFlyInventory,
  flyAddresses,
  flyMachineMemory,
  flyMachineState,
  flyResourceStatus,
  FLY_TOKEN_VARIABLE,
  flyVolumeIds,
  flyVolumeState,
  setFlyMachineMemory,
  stopFlyMachine,
} from './fly.js';
import { createLiveHarness } from './harness.js';

import type { HarnessId } from '#core/catalog';
import type { WorkstationProfile } from '#core/profile';
import type { WorkstationRecord } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

import type { LiveCli } from './cli.js';
import type { FlyMachineTarget } from './fly.js';

/** the root filesystem facts a cold boot must keep, read as root */
interface BootFacts {
  /** the kernel's id of the current boot */
  bootId: string;
  /** whether the marker written to the root filesystem before the stop exists */
  marker: boolean;
  /** `id` of the agent and Homebrew accounts */
  ids: string[];
  /** the accounts' passwd entries, with their homes and shells */
  accounts: string[];
  /** the Homebrew account's password status */
  homebrewPassword: string;
  /** every sudoers line naming either account */
  sudoRules: string[];
  /** owner, group, mode and path of every directory the volume holds */
  owners: string[];
}

/** what a boot recorded about itself on the volume */
interface BootStatus {
  /** the kernel's id of the boot */
  bootId: string;
  /** ok, or failed when any step failed */
  status: string;
  /** the whole boot script's duration */
  durationMs: number;
  /** each step's outcome and duration */
  steps: Record<string, { outcome: string; durationMs: number }>;
}

const PORT = 8080;
/** a dotted release version anywhere in a version probe's output */
const DOTTED_VERSION = /\b\d{1,4}\.\d{1,4}/u;
const MINUTE_MS = 60_000;
const CREATE_TIMEOUT_MS = 40 * MINUTE_MS;
const COMMAND_TIMEOUT_MS = 8 * MINUTE_MS;
const LIFECYCLE_TIMEOUT_MS = 100 * MINUTE_MS;
const PREFLIGHT_TIMEOUT_MS = 2 * MINUTE_MS;
const PREFLIGHT_TEST_TIMEOUT_MS = 10 * MINUTE_MS;
/** the short idle timeout the governed machines are created with */
const IDLE_MINUTES = 1;
/** the governor ticks about once a minute, so a suspend follows the timeout by up to this long again */
const SUSPEND_TIMEOUT_MS = 8 * MINUTE_MS;
const COLD_SERVE_TIMEOUT_MS = 10 * MINUTE_MS;
const RESTART_TIMEOUT_MS = 5 * MINUTE_MS;
/** an idle timeout of 0 must outlast several governor ticks */
const NEVER_SUSPENDS_MS = 5 * MINUTE_MS;
const HOLD_TIMEOUT_MS = 90_000;
const SAMPLE_MS = 5_000;
/** the exposure that ends create may land this long before create returns */
const EXPOSURE_MARGIN_MS = 30_000;
const MINIMUM_OBSERVATIONS = 5;
const MINIMUM_SCANNED_FILES = 50;
/** above the 2 GB a machine can still be suspended with */
const LARGE_MEMORY_MB = 4_096;
const CAPACITY_ATTEMPTS = 3;
const RESIZE_ATTEMPTS = 5;
const CAPACITY_RETRY_MS = 30_000;
const NODE_LINK = '/usr/local/bin/node';
const HOLD_SOURCE = 'flyprobe';
const HOLD_SESSION = 'fly07';
/** the ACP agent's unauthenticated environment answer */
const AGENT_PATH = '/.well-known/t3/environment';
const GOVERNOR_STATE = `${GUEST_ROOT}/run/awake/governor.json`;
// connects to the guest-local Machines API and reports how it went
const SOCKET_PROBE =
  "require('net').connect('/.fly/api').on('connect',()=>{console.log('connected');process.exit(0)}).on('error',(e)=>{console.log(e.code);process.exit(0)})";
// reads the live token from standard input, so it never reaches a command
// line, and reports every file of the guest's writable and configuration
// areas, and every process environment and command line, that holds it or
// any macaroon-shaped Fly token
const TOKEN_SCAN = [
  "const fs=require('fs');const path=require('path');",
  "const token=fs.readFileSync(0,'utf8').trim();",
  "const body=token.replace(/^FlyV1\\s+/,'');",
  'const shape=/Fly[V]1 fm|fm[12]r?_[A-Za-z0-9+\\/=_-]{40,}/;',
  "const skip=new Set(['node_modules','.linuxbrew','Cellar','.git','tools','apt','linuxbrew']);",
  'const hits=[];let scanned=0;',
  "const check=(file)=>{let data;try{data=fs.readFileSync(file,'latin1')}catch{return}scanned++;if(data.includes(token)||data.includes(body)||shape.test(data))hits.push(file)};",
  "const walk=(dir)=>{let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true})}catch{return}for(const entry of entries){const full=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory()){if(!skip.has(entry.name)&&!entry.name.startsWith('node-v')&&entry.name!=='node')walk(full)}else if(entry.isFile()){let size=0;try{size=fs.statSync(full).size}catch{continue}if(size<=2000000)check(full)}}};",
  "for(const root of ['/etc','/root','/home/agent','/opt/open-agent','/run','/tmp','/var/log','/usr/local/sbin','/usr/local/bin'])walk(root);",
  "for(const pid of fs.readdirSync('/proc').filter((entry)=>/^\\d+$/.test(entry)&&Number(entry)!==process.pid)){check('/proc/'+pid+'/environ');check('/proc/'+pid+'/cmdline')}",
  'console.log(JSON.stringify({scanned,hits}));',
].join('');
// the Node and sleep processes, and init, that are older than twenty seconds,
// each as pid, start tick and program: a process keeps all three across a
// suspend and resume, and a new process cannot
const PROCESS_SNAPSHOT = [
  'up=$(cut -d. -f1 /proc/uptime)',
  'for d in /proc/[0-9]*; do',
  `  pid=\${d#/proc/}`,
  '  [ "$pid" = "$$" ] && continue',
  '  exe=$(readlink "$d/exe" 2>/dev/null) || continue',
  `  case "\${exe##*/}" in`,
  `    node|sleep) program=\${exe##*/} ;;`,
  '    *) [ "$pid" = 1 ] && program=init || continue ;;',
  '  esac',
  '  start=$(cut -d" " -f22 "$d/stat" 2>/dev/null) || continue',
  '  [ $((up * 100 - start)) -gt 2000 ] && echo "$pid:$start:$program"',
  'done | sort',
].join('\n');
/** a file on the root filesystem, which a cold boot discards */
const ROOTFS_MARKER = '/root/open-agent-cold-boot';
/** removes what the boot script rebuilds on the root filesystem: Node's links, the login profile, the package Node needs and the marker */
const RESET_ROOTFS = `rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx ${PROFILE_PATH} ${ROOTFS_MARKER} ${ROOTFS_RESTORED} && dpkg --remove --force-depends libatomic1 >/dev/null`;
/** the installer's environment for brew, so its configuration is read as the installer runs it */
const BREW = `runuser -u ${HOMEBREW.account} -- /usr/bin/env -i HOME=${HOMEBREW.home} PATH=/usr/bin:/bin HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_BOTTLE_SOURCE_FALLBACK=1 ${HOMEBREW.brew}`;
const STEP_TIMEOUT_MS = 120_000;
const SERVE_TIMEOUT_MS = 5 * 60_000;
const LISTING_TIMEOUT_MS = 3 * 60_000;
const POLL_MS = 5_000;
const HTTP_TIMEOUT_MS = 15_000;
const OK_STATUS = 200;
const NOT_FOUND_STATUS = 404;
const STREAMED_STATUS = 3;
/** a stopped machine must stay stopped for this long after list and get */
const STOPPED_OBSERVATION_MS = 15_000;
// DNS over HTTPS bypasses this computer's resolver cache, so the name is
// looked up afresh once exposure has assigned the app its addresses
const SERVING_RESOLVER = 'https://cloudflare-dns.com/dns-query';
const A_RECORD = 1;
const VOLUME_FILE = '/data/open-agent-probe.txt';
// a Socket-only HTTP listener, since the stock image carries perl-base alone
const LISTENER = [
  'use Socket;',
  'socket(my $s, PF_INET, SOCK_STREAM, 0) or die;',
  'setsockopt($s, SOL_SOCKET, SO_REUSEADDR, 1);',
  'bind($s, sockaddr_in($ARGV[0], INADDR_ANY)) or die;',
  'listen($s, 16) or die;',
  'while (accept(my $c, $s)) {',
  '  sysread($c, my $r, 4096);',
  '  print $c "HTTP/1.1 200 OK\\r\\nContent-Length: " . length($ARGV[1]) .',
  '    "\\r\\nConnection: close\\r\\n\\r\\n$ARGV[1]";',
  '  close $c;',
  '}',
].join('\n');

/**
 * resolves a name to an IPv4 address through DNS over HTTPS
 * @param hostname name to resolve
 * @param resolver JSON DNS-over-HTTPS endpoint
 * @returns first address, or nothing while the name does not resolve
 */
async function resolveAddress(
  hostname: string,
  resolver: string,
): Promise<string | undefined> {
  const query = new URLSearchParams({ name: hostname, type: 'A' });
  const response = await fetch(`${resolver}?${query.toString()}`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  }).catch(() => undefined);
  const answer: unknown = await response?.json().catch(() => undefined);
  const records =
    isRecord(answer) && Array.isArray(answer.Answer) ? answer.Answer : [];

  return records
    .filter(isRecord)
    .flatMap((record) =>
      record.type === A_RECORD && typeof record.data === 'string'
        ? [record.data]
        : [],
    )
    .at(0);
}

/**
 * fetches a public URL through a resolver this computer has not cached
 * @param url absolute https URL
 * @param path path to request below the URL's host
 * @returns status and body, or nothing while the name does not resolve
 */
async function fetchPublic(
  url: string,
  path = '/',
): Promise<{ status: number; body: string } | undefined> {
  const { hostname } = new URL(url);
  const address = await resolveAddress(hostname, SERVING_RESOLVER);
  if (!address) {
    return undefined;
  }

  return new Promise((resolve) => {
    const call = request(
      {
        host: address,
        servername: hostname,
        headers: { host: hostname },
        path,
        timeout: HTTP_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    call.on('timeout', () => call.destroy());
    call.on('error', () => resolve(undefined));
    call.end();
  });
}

/**
 * polls until a condition holds or a deadline passes
 * @param timeoutMs upper bound
 * @param probe returns a value once the condition holds
 * @returns the first value the probe returned
 */
async function waitFor<T>(
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined || Date.now() >= deadline) {
      return value;
    }
    await delay(POLL_MS);
  }
}

/**
 * streams one input-carrying session that echoes its input and exits 3
 * @param channel guest channel
 * @param input text written to the session before its input closes
 * @returns exit status and standard output
 */
async function streamThrough(
  channel: GuestChannel,
  input: string,
): Promise<{ exitCode: number; stdout: string }> {
  const session = channel.spawn({
    program: '/bin/sh',
    arguments: ['-c', `cat; exit ${STREAMED_STATUS}`],
  });
  const chunks: Buffer[] = [];
  session.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  session.stdin.end(input);

  return new Promise((resolve, reject) => {
    session.on('error', reject);
    session.on('exit', (exitCode: number) => {
      resolve({ exitCode, stdout: Buffer.concat(chunks).toString() });
    });
  });
}

/**
 * tells whether a flyctl agent of open-agent's private configuration runs;
 * the user's own agent, of another configuration directory, never counts
 * @returns true while such an agent process exists
 */
async function privateAgentRunning(): Promise<boolean> {
  const { stdout } = await promisify(execFile)('ps', ['-ax', '-o', 'command=']);

  return stdout
    .split('\n')
    .some(
      (command) =>
        command.includes(' agent run ') &&
        command.includes(flyctlConfigDirectory()),
    );
}

/**
 * decodes an SSH token derived from the live token for one app, as flyctl
 * itself reads it
 * @param credential Fly organization token
 * @param name app name
 * @returns why the derived token is no organization token
 */
async function derivedScope(
  credential: string,
  name: string,
): Promise<string | undefined> {
  const app = await new FlyApi(credential).getApp(name);
  const derived = await deriveSshToken(credential, app.numericId);

  return tokenScopeProblem(
    (await decodeToken(FLYCTL, derived)) ?? '',
    new Date(),
  );
}

/**
 * runs a shell script as root through the guest channel
 * @param channel guest channel
 * @param script POSIX shell script
 * @returns standard output, once the script succeeded
 */
async function asRoot(channel: GuestChannel, script: string): Promise<string> {
  const result = await channel.exec({
    program: '/bin/sh',
    arguments: ['-c', script],
    timeoutMs: STEP_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${script} exited ${result.exitCode}: ${result.stderr}`);
  }

  return result.stdout;
}

/**
 * reads the facts a cold boot must reset or keep
 * @param channel guest channel
 * @returns boot id, marker, accounts, sudo rules and volume ownership
 */
async function readBootFacts(channel: GuestChannel): Promise<BootFacts> {
  const lines = async (script: string): Promise<string[]> =>
    (await asRoot(channel, script)).split('\n').filter(Boolean);
  const accounts = `agent ${HOMEBREW.account}`;

  return {
    bootId: (
      await asRoot(channel, 'cat /proc/sys/kernel/random/boot_id')
    ).trim(),
    marker:
      (
        await asRoot(channel, `test -e ${ROOTFS_MARKER} && echo yes || echo no`)
      ).trim() === 'yes',
    ids: await lines(`for name in ${accounts}; do id "$name"; done`),
    accounts: await lines(`getent passwd ${accounts}`),
    homebrewPassword: (
      await asRoot(channel, `passwd -S ${HOMEBREW.account} | cut -d' ' -f1,2`)
    ).trim(),
    sudoRules: await lines(
      `cat /etc/sudoers /etc/sudoers.d/* 2>/dev/null | grep -E '(^|[^a-z])(agent|${HOMEBREW.account})([^a-z]|$)' || true`,
    ),
    owners: await lines(
      `stat -c '%u:%g %a %n' /data /data/open-agent ${GUEST_ROOT} /home/agent ${HOMEBREW.home} ${HOMEBREW.prefix} ${HOMEBREW.prefix}/Cellar`,
    ),
  };
}

/**
 * reads the last boot's status and its lines in the boot log
 * @param channel guest channel
 * @param bootId the boot to read the log lines of
 * @returns the recorded status, the steps the log names for the boot and the boot's log lines
 */
async function readBootRecord(
  channel: GuestChannel,
  bootId: string,
): Promise<{
  status: BootStatus;
  logged: Record<string, string>;
  lines: string[];
}> {
  const status = JSON.parse(
    await asRoot(channel, `cat ${BOOT_STATUS}`),
  ) as BootStatus;
  const log = (await asRoot(channel, `cat ${BOOT_LOG}`)).split('\n');
  const start = log.findLastIndex((line) =>
    line.includes(`boot id=${bootId} started`),
  );
  const logged = Object.fromEntries(
    log.slice(start).flatMap((line) => {
      const match = /step=(\S+) outcome=(\S+)/u.exec(line);

      return match ? [[match[1], match[2]]] : [];
    }),
  );

  return { status, logged, lines: log.slice(start).filter(Boolean) };
}

/**
 * runs each harness CLI's version probe from a fresh login shell of the agent
 * @param channel guest channel
 * @param harnesses harnesses the workstation installed
 * @returns each harness's first output line
 */
async function readHarnessVersions(
  channel: GuestChannel,
  harnesses: readonly HarnessId[],
): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const { tools } of harnessDrivers(harnesses)) {
    const [tool] = tools;
    if (tool === undefined) {
      continue;
    }
    const program = basename(tool.version.executable);
    versions[program] =
      (
        await asRoot(channel, `runuser -l agent -c '${program} --version'`)
      ).split('\n')[0] ?? '';
  }

  return versions;
}

const live = inject('live');
const harness = await createLiveHarness(live);
const token: string =
  parse(await readFile(live.envFile, 'utf8'))[FLY_TOKEN_VARIABLE]?.trim() ?? '';
if (token === '') {
  throw new Error(`${FLY_TOKEN_VARIABLE} is required in the live dotenv file`);
}
const profile: WorkstationProfile = {
  ...defaultProfile('none'),
  provider: 'fly-machine',
};

/**
 * authenticates the Fly Machine provider with the live token
 * @returns an authenticated provider
 */
function flyProvider(): ReturnType<
  (typeof catalog.providers)['fly-machine']['authenticate']
> {
  return catalog.providers['fly-machine'].authenticate({
    credential: token,
    restorableServices: [],
  });
}

/**
 * builds a non-interactive create of a Fly workstation with no private
 * network, proxy, GitHub access, plugins or Git identity
 * @param name name the workstation takes
 * @param idleMinutes suspend-after-idle minutes; 0 never suspends
 * @returns CLI arguments
 */
function flyCreateArguments(name: string, idleMinutes: number): string[] {
  return [
    'create',
    '--name',
    name,
    '--provider',
    'fly-machine',
    '--network',
    'none',
    '--no-proxy',
    '--no-github',
    '--no-plugins',
    '--no-git-identity',
    '--harness',
    'claude',
    '--idle-minutes',
    String(idleMinutes),
  ];
}

/**
 * builds a CLI with a home of its own. flyctl's SSH agent is shared by every
 * process of one home and stopped by the first of them to finish, so tests that
 * run side by side must not share a home
 * @param tag short name of the home, below the run's home
 * @returns CLI driver bound to that home
 */
async function isolatedCli(tag: string): Promise<LiveCli> {
  const home = join(live.home, tag);
  await mkdir(home, { recursive: true });

  return createLiveCli({
    bin: live.bin,
    envFile: live.envFile,
    home,
    redact: harness.redact,
  });
}

/**
 * creates a Fly workstation through the CLI
 * @param name name the workstation takes
 * @param idleMinutes suspend-after-idle minutes; 0 never suspends
 * @param run how the create runs
 * @param run.cli CLI driver to run it with
 * @param run.signal aborts the create early
 * @returns the created workstation's record
 */
async function createFlyWorkstation(
  name: string,
  idleMinutes: number,
  run: { cli: LiveCli; signal: AbortSignal },
): Promise<WorkstationRecord> {
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await run.cli.json(
      flyCreateArguments(name, idleMinutes),
      CREATE_TIMEOUT_MS,
      run.signal,
    );
    // Fly may have no room for a machine beside the new volume at that moment;
    // such a create leaves nothing behind, so it is safe to ask again
    const hasNoRoom =
      !outcome.envelope.ok &&
      JSON.stringify(outcome.envelope.error).includes('insufficient resources');
    if (!hasNoRoom || attempt >= CAPACITY_ATTEMPTS) {
      successData(outcome, 'create');

      return flyProvider().get(name);
    }
    await delay(CAPACITY_RETRY_MS, undefined, { signal: run.signal });
  }
}

/**
 * asks the ACP agent behind a workstation URL for its environment
 * @param url the workstation's public URL
 * @returns the answer once the agent gave it, or nothing while it did not
 */
async function serveAgent(
  url: string,
): Promise<{ status: number; body: string } | undefined> {
  const response = await fetchPublic(url, AGENT_PATH);

  return response?.status === OK_STATUS ? response : undefined;
}

/**
 * records, in the background, how many addresses an app holds
 * @param name app name
 * @returns the observations, once stopped
 */
function watchAddresses(name: string): {
  stop: () => Promise<Array<{ at: number; addresses: number }>>;
} {
  const observations: Array<{ at: number; addresses: number }> = [];
  const controller = new AbortController();
  const loop = (async () => {
    while (!controller.signal.aborted) {
      const addresses = await flyAddresses(token, name).then(
        (list) => list.length,
        () => 0,
      );
      observations.push({ at: Date.now(), addresses });
      await delay(POLL_MS, undefined, { signal: controller.signal }).catch(
        () => undefined,
      );
    }
  })();

  return {
    async stop() {
      controller.abort();
      await loop;

      return observations;
    },
  };
}

/**
 * records, in the background, every run state a machine reports
 * @param name app name
 * @param machine machine identity
 * @returns the states in order, once stopped
 */
function watchStates(
  name: string,
  machine: string,
): { stop: () => Promise<string[]> } {
  const states: string[] = [];
  const controller = new AbortController();
  const loop = (async () => {
    while (!controller.signal.aborted) {
      await flyMachineState(token, name, machine).then(
        (state) => states.push(state),
        () => undefined,
      );
      await delay(SAMPLE_MS, undefined, { signal: controller.signal }).catch(
        () => undefined,
      );
    }
  })();

  return {
    async stop() {
      controller.abort();
      await loop;

      return states;
    },
  };
}

/**
 * polls a machine's run state until it is the wanted one
 * @param target the machine to poll
 * @param wanted state to wait for
 * @param timeoutMs upper bound
 * @returns the wanted state, or nothing when the deadline passed
 */
async function awaitState(
  target: FlyMachineTarget,
  wanted: string,
  timeoutMs: number,
): Promise<string | undefined> {
  return waitFor(timeoutMs, async () => {
    const state = await flyMachineState(token, target.app, target.machine);

    return state === wanted ? state : undefined;
  });
}

/**
 * resizes a machine only while it is started: a short idle timeout may be
 * suspending it, and Fly refuses a configuration change mid-transition (409),
 * so the machine is woken by a request and awaited, and the change repeated
 * @param target the machine to resize
 * @param url the machine's public address, whose request wakes it
 * @param memoryMb new memory in megabytes
 */
async function resizeStartedMachine(
  target: FlyMachineTarget,
  url: string,
  memoryMb: number,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    await waitFor(RESTART_TIMEOUT_MS, async () => serveAgent(url));
    await awaitState(target, 'started', RESTART_TIMEOUT_MS);
    try {
      await setFlyMachineMemory(token, target, memoryMb);

      return;
    } catch (error) {
      if (attempt >= RESIZE_ATTEMPTS || !String(error).includes('409')) {
        throw error;
      }
    }
  }
}

/**
 * samples a machine's run state until a duration has passed or a state ends it
 * @param target the machine to sample
 * @param span how long to sample, and what ends it early
 * @param span.durationMs how long to sample, from the start
 * @param span.startedAt when the duration began
 * @param span.endsWith ends the sampling early on the state it accepts
 * @returns every state sampled, in order
 */
async function sampleStates(
  target: FlyMachineTarget,
  span: {
    durationMs: number;
    startedAt: number;
    endsWith?: (state: string) => boolean;
  },
): Promise<string[]> {
  const samples: string[] = [];
  while (Date.now() < span.startedAt + span.durationMs) {
    const state = await flyMachineState(token, target.app, target.machine);
    samples.push(state);
    if (span.endsWith?.(state)) {
      break;
    }
    await delay(SAMPLE_MS);
  }

  return samples;
}

/**
 * opens or closes a hold that keeps the machine awake, as a harness hook does
 * @param channel guest channel
 * @param action open or close
 */
async function holdAwake(
  channel: GuestChannel,
  action: 'hold-open' | 'hold-close',
): Promise<void> {
  await channel.exec({
    account: 'agent',
    program: AWAKE_COMMAND,
    arguments: [action, '--source', HOLD_SOURCE, '--session', HOLD_SESSION],
    timeoutMs: STEP_TIMEOUT_MS,
  });
}

/**
 * reads the idle governor's recorded state
 * @param channel guest channel
 * @returns the state record, or an empty record when it is not one
 */
async function readGovernor(
  channel: GuestChannel,
): Promise<Record<string, unknown>> {
  const state: unknown = JSON.parse(
    await asRoot(channel, `cat ${GOVERNOR_STATE}`),
  );

  return isRecord(state) ? state : {};
}

/**
 * lists the long-lived Node and sleep processes with their start times, which
 * identify a process across a suspend and resume
 * @param channel guest channel
 * @returns one `pid:start:program` line per process older than twenty seconds
 */
async function snapshotProcesses(channel: GuestChannel): Promise<string[]> {
  return (await asRoot(channel, PROCESS_SNAPSHOT)).split('\n').filter(Boolean);
}

/**
 * finds a program on the PATH of this process
 * @param program program name
 * @returns its absolute path
 */
async function findOnPath(program: string): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, program);
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    ) {
      return candidate;
    }
  }

  throw new Error(`${program} is not on the PATH of the live suite`);
}

describe('Fly Machine provider live probe', () => {
  it('should accept the live token and flyctl through the real preflight', async ({
    expect,
  }) => {
    const problems = await providerPreflight('fly-machine', {
      token,
      source: FLY_TOKEN_VARIABLE,
    });

    expect(problems).toEqual([]);
  });

  it('should create, serve, record, stop and delete one workstation', async ({
    expect,
  }) => {
    const credential = token;
    const name = harness.workstationName('fly');
    const provider = catalog.providers['fly-machine'].authenticate({
      credential,
      restorableServices: [],
    });
    const banner = `open-agent probe ${live.runId}`;

    await harness.withWorkstation(name, async () => {
      const created = await provider.create(name, profile, PORT);
      const volumes = await flyVolumeIds(credential, name);

      expect({
        created,
        volumes: volumes.length,
        addresses: await flyAddresses(credential, name),
        derivedScope: await derivedScope(credential, name),
      }).toEqual({
        created: expect.objectContaining({
          name,
          state: 'started',
          url: `https://${name}.fly.dev`,
          metadata: {
            setup: 'not recorded',
            profile: summarizeProfile(profile),
          },
        }),
        volumes: 1,
        addresses: [],
        derivedScope: expect.stringContaining('narrowed') as string,
      });

      const channel = await provider.openGuest(created);
      const session = await channel.exec({
        program: '/bin/sh',
        arguments: ['-c', 'printf out; printf err >&2; exit 42'],
        input: '',
      });
      const quick = await channel.exec({
        program: '/usr/bin/id',
        arguments: ['-u'],
        timeoutMs: STEP_TIMEOUT_MS / 4,
      });
      const streamed = await streamThrough(channel, 'streamed input');

      expect({ session, quick, streamed }).toEqual({
        session: { exitCode: 42, stdout: 'out', stderr: 'err' },
        quick: { exitCode: 0, stdout: '0\n', stderr: '' },
        streamed: { exitCode: STREAMED_STATUS, stdout: 'streamed input' },
      });

      await channel.exec({
        program: '/usr/bin/tee',
        arguments: [VOLUME_FILE],
        input: banner,
      });
      const mounts = await channel.read('/proc/mounts');
      const environment = await channel.exec({
        program: '/bin/sh',
        arguments: ['-c', 'env; tr "\\0" "\\n" </proc/1/environ'],
        timeoutMs: STEP_TIMEOUT_MS / 4,
      });

      expect({
        stored: await channel.read(VOLUME_FILE),
        exists: await channel.exists(VOLUME_FILE),
        volumeMounted: mounts
          .split('\n')
          .some((line) => line.split(' ')[1] === '/data'),
        tokenOnGuest:
          environment.stdout.includes(credential) ||
          environment.stdout.includes('FlyV1'),
      }).toEqual({
        stored: banner,
        exists: true,
        volumeMounted: true,
        tokenOnGuest: false,
      });

      const listener = await channel.exec({
        program: '/bin/sh',
        arguments: [
          '-c',
          'setsid nohup perl -e "$1" "$2" "$3" </dev/null >/dev/null 2>&1 &',
          'probe',
          LISTENER,
          String(PORT),
          banner,
        ],
        timeoutMs: STEP_TIMEOUT_MS,
      });
      const privateAddresses = await flyAddresses(credential, name);
      await provider.expose(created, PORT, 'public');
      const served = await waitFor(SERVE_TIMEOUT_MS, async () => {
        const response = await fetchPublic(created.url ?? '');

        return response?.status === OK_STATUS ? response : undefined;
      });

      expect({
        listener: listener.exitCode,
        privateAddresses,
        publicAddresses: (await flyAddresses(credential, name)).length,
        served,
      }).toEqual({
        listener: 0,
        privateAddresses: [],
        publicAddresses: 2,
        served: { status: OK_STATUS, body: banner },
      });

      const metadata = {
        setup: 'ready' as const,
        profile: summarizeProfile(profile),
      };
      const recorded = await provider.setMetadata(created, metadata);
      const listed = await waitFor(LISTING_TIMEOUT_MS, async () =>
        (await provider.list()).find(
          (record: WorkstationRecord) =>
            record.name === name && record.metadata.setup === 'ready',
        ),
      );
      const fetched = await provider.get(name);
      const stillServed = await fetchPublic(created.url ?? '');
      const identity = { id: created.id, name, metadata };

      expect({ recorded, listed, fetched, stillServed }).toEqual({
        recorded: expect.objectContaining(identity),
        listed: expect.objectContaining(identity),
        fetched: expect.objectContaining(identity),
        stillServed: { status: OK_STATUS, body: banner },
      });

      // private again, so no internet traffic can wake the stopped machine
      await provider.expose(fetched, PORT, 'private');
      await stopFlyMachine(credential, name, created.id);
      // the organization listing may lag, so it is read until it agrees
      const observed = {
        listed: await waitFor(LISTING_TIMEOUT_MS, async () => {
          const state = (await provider.list()).find(
            (record) => record.name === name,
          )?.state;

          return state === 'stopped' ? state : undefined;
        }),
        fetched: (await provider.get(name)).state,
      };
      await delay(STOPPED_OBSERVATION_MS);

      expect({
        addresses: await flyAddresses(credential, name),
        observed,
        after: await flyMachineState(credential, name, created.id),
        agentRunning: await privateAgentRunning(),
      }).toEqual({
        addresses: [],
        observed: { listed: 'stopped', fetched: 'stopped' },
        after: 'stopped',
        agentRunning: false,
      });

      await provider.delete(await provider.get(name));

      expect({
        resources: await flyResourceStatus(credential, name),
        volumes: await Promise.all(
          volumes.map(async (id) => flyVolumeState(credential, id)),
        ),
      }).toEqual({
        resources: {
          app: NOT_FOUND_STATUS,
          machines: NOT_FOUND_STATUS,
          volumes: NOT_FOUND_STATUS,
        },
        volumes: volumes.map(() => undefined),
      });
    });
  });

  it.concurrent(
    'should suspend, resume with its processes, cold boot and update a workstation created through the CLI',
    async ({ expect, signal, annotate }) => {
      const name = harness.workstationName('life');
      const cli = await isolatedCli('l');

      await harness.withWorkstation(name, async () => {
        const observing = watchAddresses(name);
        const created = successData(
          await cli.json(
            flyCreateArguments(name, IDLE_MINUTES),
            CREATE_TIMEOUT_MS,
            signal,
          ),
          'create',
        );
        const returnedAt = Date.now();
        const observations = await observing.stop();
        const provider = flyProvider();
        const record = await provider.get(name);
        const url = record.url ?? '';
        const served = await waitFor(SERVE_TIMEOUT_MS, async () =>
          serveAgent(url),
        );

        // exposure is the last step of create, after the readiness checks, so
        // no address may exist while those checks ran
        expect({
          ready: created.readiness.ready,
          publicBeforeReadiness: observations.filter(
            ({ at, addresses }) =>
              at < returnedAt - EXPOSURE_MARGIN_MS && addresses > 0,
          ),
          observed: observations.length > MINIMUM_OBSERVATIONS,
          addresses: (await flyAddresses(token, name)).length,
          served: served?.status,
          environment: served?.body.includes('environmentId'),
        }).toEqual({
          ready: true,
          publicBeforeReadiness: [],
          observed: true,
          addresses: 2,
          served: OK_STATUS,
          environment: true,
        });

        // keep the machine awake while it is examined, so the examination is
        // never cut short by the idle timeout it is about to prove
        const channel = await provider.openGuest(record);
        await holdAwake(channel, 'hold-open');
        const hold = await waitFor(HOLD_TIMEOUT_MS, async () => {
          const state = await readGovernor(channel);

          return Number(state.openHolds) > 0 ? state : undefined;
        });
        const scan = JSON.parse(
          (
            await channel.exec({
              program: NODE_LINK,
              arguments: ['-e', TOKEN_SCAN],
              input: `${token}\n`,
              timeoutMs: STEP_TIMEOUT_MS,
            })
          ).stdout,
        ) as { scanned: number; hits: string[] };
        const socket = async (account?: 'agent'): Promise<string> =>
          (
            await channel.exec({
              account,
              program: NODE_LINK,
              arguments: ['-e', SOCKET_PROBE],
              timeoutMs: STEP_TIMEOUT_MS,
            })
          ).stdout.trim();

        expect({
          held: Number(hold?.openHolds) > 0,
          tokenHits: scan.hits,
          scanned: scan.scanned > MINIMUM_SCANNED_FILES,
          agentSocket: await socket('agent'),
          rootSocket: await socket(),
        }).toEqual({
          held: true,
          tokenHits: [],
          scanned: true,
          agentSocket: expect.stringMatching(/^(EACCES|EPERM)$/u) as string,
          rootSocket: 'connected',
        });

        const banner = `open-agent volume ${live.runId}`;
        await channel.exec({
          program: '/usr/bin/tee',
          arguments: [VOLUME_FILE],
          input: banner,
        });
        await asRoot(channel, `touch ${ROOTFS_MARKER}`);
        await channel.exec({
          account: 'agent',
          program: '/bin/sh',
          arguments: [
            '-c',
            'setsid nohup sleep 86401 </dev/null >/dev/null 2>&1 &',
          ],
        });
        const manifest = JSON.parse(
          await asRoot(channel, `cat ${GUEST_ROOT}/manifest.json`),
        ) as { profile: { harnesses: HarnessId[] } };
        const before = await readBootFacts(channel);
        const processesBefore = await waitFor(HOLD_TIMEOUT_MS, async () => {
          const lines = await snapshotProcesses(channel);

          return lines.some((line) => line.endsWith(':sleep'))
            ? lines
            : undefined;
        });

        await holdAwake(channel, 'hold-close');

        // with the hold closed only the short idle timeout remains, and the
        // machine suspends itself
        const idleSince = Date.now();
        const suspended = await awaitState(
          { app: name, machine: record.id },
          'suspended',
          SUSPEND_TIMEOUT_MS,
        );
        const suspendedAfterMs = Date.now() - idleSince;

        expect(suspended).toBe('suspended');

        // a URL request resumes it, and the agent answers from the same boot
        const wakeRequestedAt = Date.now();
        const woken = await waitFor(SERVE_TIMEOUT_MS, async () =>
          serveAgent(url),
        );
        const resumedAt = Date.now();
        const resumedState = await flyMachineState(token, name, record.id);
        const resumed = await flyProvider().openGuest(record);
        const processesAfter = await snapshotProcesses(resumed);
        const bootIdAfter = (
          await asRoot(resumed, 'cat /proc/sys/kernel/random/boot_id')
        ).trim();

        expect({
          served: woken?.status,
          state: resumedState,
          sameBoot: bootIdAfter === before.bootId,
          survivors: processesAfter,
        }).toEqual({
          served: OK_STATUS,
          state: 'started',
          sameBoot: true,
          survivors: expect.arrayContaining(processesBefore ?? []) as string[],
        });
        expect(processesBefore?.length).toBeGreaterThan(1);

        // the resume must not be taken for idleness: nothing suspends the
        // machine again within the idle timeout that follows it
        const window = await sampleStates(
          { app: name, machine: record.id },
          { durationMs: IDLE_MINUTES * MINUTE_MS, startedAt: resumedAt },
        );

        expect(window.filter((state) => state !== 'started')).toEqual([]);

        // and the governor still governs: with nothing touching the guest it
        // suspends the machine again
        const again = await awaitState(
          { app: name, machine: record.id },
          'suspended',
          SUSPEND_TIMEOUT_MS,
        );

        expect(again).toBe('suspended');

        // Fly keeps the root filesystem across a stop that follows a suspend
        // and a resume, so a plain stop would leave nothing for the boot
        // script to restore. The machine is woken and the files the boot
        // script rebuilds are removed, which is the loss a stop brings on a
        // machine that was never suspended
        await waitFor(SERVE_TIMEOUT_MS, async () => serveAgent(url));
        const keptRootfs = (
          await asRoot(
            await flyProvider().openGuest(record),
            `kept=no; test -e ${ROOTFS_MARKER} && kept=yes; ${RESET_ROOTFS}; echo $kept`,
          )
        ).trim();

        // a forced stop, then a URL request: the machine cold boots
        await stopFlyMachine(token, name, record.id);
        const stoppedAt = Date.now();
        await delay(STOPPED_OBSERVATION_MS);
        const stillStopped = await flyMachineState(token, name, record.id);
        const coldRequestedAt = Date.now();
        const cold = await waitFor(COLD_SERVE_TIMEOUT_MS, async () =>
          serveAgent(url),
        );
        const coldServedMs = Date.now() - coldRequestedAt;

        expect({
          stillStopped,
          served: cold?.status,
          state: await flyMachineState(token, name, record.id),
        }).toEqual({
          stillStopped: 'stopped',
          served: OK_STATUS,
          state: 'started',
        });

        const booted = await flyProvider().openGuest(record);
        await holdAwake(booted, 'hold-open');
        const after = await readBootFacts(booted);
        const { status, logged, lines } = await readBootRecord(
          booted,
          after.bootId,
        );

        await annotate(
          `suspend: ${suspendedAfterMs} ms after the hold closed; resume: the URL request was answered in ${resumedAt - wakeRequestedAt} ms with the same boot id and ${processesBefore?.length ?? 0} processes intact`,
        );
        await annotate(
          `cold boot: ${coldServedMs} ms from the URL request to the agent's answer (${coldRequestedAt - stoppedAt} ms after the stop); boot script ${status.durationMs} ms: ${Object.entries(
            status.steps,
          )
            .map(([step, { durationMs }]) => `${step} ${durationMs} ms`)
            .join(', ')}`,
        );
        await annotate(
          `root filesystem kept by Fly across the suspend, resume and stop: ${keptRootfs}`,
        );
        await annotate(`boot log:\n${lines.join('\n')}`);

        expect({ ...after, bootId: after.bootId === before.bootId }).toEqual({
          ...before,
          bootId: false,
          marker: false,
        });
        expect(before).toMatchObject({
          marker: true,
          homebrewPassword: `${HOMEBREW.account} L`,
          sudoRules: [],
        });
        expect({
          status: status.status,
          bootId: status.bootId,
          steps: Object.keys(status.steps),
          logged,
        }).toEqual({
          status: 'ok',
          bootId: after.bootId,
          steps: [...BOOT_STEPS],
          logged: Object.fromEntries(BOOT_STEPS.map((step) => [step, 'ok'])),
        });

        const tools = (
          await asRoot(
            booted,
            "runuser -l agent -c 'for tool in node git jj gh; do command -v $tool; $tool --version | head -n 1; done'",
          )
        )
          .trim()
          .split('\n');
        const brewConfig = (
          await asRoot(booted, `cd / && ${BREW} config`)
        ).split('\n');

        const supervisors = Number(
          (
            await asRoot(
              booted,
              "for d in /proc/[0-9]*; do tr '\\0' ' ' <$d/cmdline 2>/dev/null; echo; done | grep -c 'supervisor/main.j[s]'",
            )
          ).trim(),
        );

        expect(supervisors).toBeGreaterThanOrEqual(1);
        expect({
          volume: await asRoot(booted, `cat ${VOLUME_FILE}`),
          tools,
          // Node needs libatomic1 from the root filesystem, which only the
          // boot script brings back, from the package record and the apt
          // cache the first create left on the volume
          recorded: (
            await asRoot(
              booted,
              `grep -x libatomic1 ${VOLUME_LAYOUT.packages} || true`,
            )
          ).trim(),
          cached: (
            await asRoot(
              booted,
              `ls ${VOLUME_LAYOUT.apt}/archives | grep '^libatomic1_' || true`,
            )
          ).trim(),
          brew: brewConfig.filter((line) =>
            line.startsWith('HOMEBREW_PREFIX:'),
          ),
          harnesses: await readHarnessVersions(
            booted,
            manifest.profile.harnesses,
          ),
        }).toEqual({
          volume: banner,
          tools: [
            '/usr/local/bin/node',
            expect.stringMatching(/^v\d+\./u) as string,
            '/usr/local/bin/git',
            expect.stringMatching(/^git version \d/u) as string,
            '/usr/local/bin/jj',
            expect.stringMatching(/^jj \d/u) as string,
            '/usr/local/bin/gh',
            expect.stringMatching(/^gh version \d/u) as string,
          ],
          recorded: 'libatomic1',
          cached: expect.stringMatching(/^libatomic1_\S+\.deb$/u) as string,
          brew: [`HOMEBREW_PREFIX: ${HOMEBREW.prefix}`],
          harnesses: Object.fromEntries(
            harnessDrivers(manifest.profile.harnesses).flatMap(({ tools }) =>
              tools.map(({ version }) => [
                basename(version.executable),
                expect.stringMatching(DOTTED_VERSION) as string,
              ]),
            ),
          ),
        });
        const update = successData(
          await cli.json(
            ['setup', name, '--section', 'tools', '--update'],
            COMMAND_TIMEOUT_MS,
            signal,
          ),
          'setup',
        );

        expect(update).toMatchObject({
          tools: 'updated',
          components: { installed: 0 },
        });
      });
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it.concurrent(
    'should stop instead of suspend a machine configured above 2 GB',
    async ({ expect, signal, annotate }) => {
      const name = harness.workstationName('big');
      const cli = await isolatedCli('b');

      await harness.withWorkstation(name, async () => {
        const record = await createFlyWorkstation(name, IDLE_MINUTES, {
          cli,
          signal,
        });

        const watching = watchStates(name, record.id);
        await resizeStartedMachine(
          { app: name, machine: record.id },
          record.url ?? '',
          LARGE_MEMORY_MB,
        );
        // the agent answers only once the machine has restarted at its new size
        const restarted = await waitFor(RESTART_TIMEOUT_MS, async () =>
          serveAgent(record.url ?? ''),
        );
        const stopped = await awaitState(
          { app: name, machine: record.id },
          'stopped',
          SUSPEND_TIMEOUT_MS,
        );
        const states = await watching.stop();
        const cold = await waitFor(COLD_SERVE_TIMEOUT_MS, async () =>
          serveAgent(record.url ?? ''),
        );
        const log = await asRoot(
          await flyProvider().openGuest(record),
          `tail -n 40 ${GUEST_ROOT}/supervisor.log`,
        );

        await annotate(
          `memory ${await flyMachineMemory(token, name, record.id)} MB: states ${[...new Set(states)].join(' -> ')}; supervisor log:\n${log}`,
        );
        expect({
          restarted: restarted?.status,
          memory: await flyMachineMemory(token, name, record.id),
          suspended: states.includes('suspended'),
          stopped,
          woken: cold?.status,
        }).toEqual({
          restarted: OK_STATUS,
          memory: LARGE_MEMORY_MB,
          suspended: false,
          stopped: 'stopped',
          woken: OK_STATUS,
        });
      });
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it.concurrent(
    'should never suspend with an idle timeout of 0, and terminate deletes the app, machine and volume',
    async ({ expect, signal, annotate }) => {
      const name = harness.workstationName('zero');
      const cli = await isolatedCli('z');

      await harness.withWorkstation(name, async () => {
        const record = await createFlyWorkstation(name, 0, { cli, signal });
        const volumes = await flyVolumeIds(token, name);
        const governor = await readGovernor(
          await flyProvider().openGuest(record),
        );
        const states = await sampleStates(
          { app: name, machine: record.id },
          { durationMs: NEVER_SUSPENDS_MS, startedAt: Date.now() },
        );

        await annotate(
          `idle timeout 0: ${states.length} state samples over ${NEVER_SUSPENDS_MS / MINUTE_MS} minutes, ${[...new Set(states)].join(', ')}`,
        );
        expect({
          governed: governor.idleTimeoutMinutes,
          states: [...new Set(states)],
        }).toEqual({ governed: 0, states: ['started'] });

        const terminate = successData(
          await cli.json(
            ['terminate', name, '--yes'],
            COMMAND_TIMEOUT_MS,
            signal,
          ),
          'terminate',
        );

        expect(terminate).toMatchObject({
          workstation: { status: 'deleted', name },
        });
        expect({
          volumes: volumes.length,
          resources: await flyResourceStatus(token, name),
          states: await Promise.all(
            volumes.map(async (id) => flyVolumeState(token, id)),
          ),
        }).toEqual({
          volumes: 1,
          resources: {
            app: NOT_FOUND_STATUS,
            machines: NOT_FOUND_STATUS,
            volumes: NOT_FOUND_STATUS,
          },
          states: volumes.map(() => undefined),
        });
      });
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it.concurrent(
    'should refuse a create before any provider call and list every missing prerequisite with its fix',
    async ({ expect }) => {
      const directory = await mkdtemp(join(tmpdir(), 'open-agent-fly-ac11-'));
      const inventory = createFlyInventory(token);
      const body = token.replace(/^FlyV1\s+/u, '');
      const narrowed = await deriveSshToken(token, 1);
      const sprites = parse(await readFile(live.envFile, 'utf8')).SPRITES_TOKEN;

      try {
        const withNode = join(directory, 'node-only');
        const withFly = join(directory, 'node-and-fly');
        await Promise.all([mkdir(withNode), mkdir(withFly)]);
        await Promise.all(
          [withNode, withFly].map(async (bin) =>
            symlink(process.execPath, join(bin, 'node')),
          ),
        );
        await symlink(await findOnPath('fly'), join(withFly, 'fly'));

        const attempt = async (
          label: string,
          bin: string,
          variables: Record<string, string>,
        ) => {
          const name = `${live.runId}-${label}`;
          const envFile = join(directory, `${label}.env`);
          await writeFile(
            envFile,
            Object.entries(variables)
              .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
              .join('\n'),
          );
          const result = await execa(
            live.bin,
            [
              'create',
              '--name',
              name,
              '--provider',
              'fly-machine',
              '--network',
              'none',
              '--no-proxy',
              '--no-github',
              '--no-plugins',
              '--no-git-identity',
              '--json',
              '--non-interactive',
              '--no-local-credentials',
              '--env-file',
              envFile,
            ],
            {
              env: { PATH: bin, HOME: live.home, NO_COLOR: '1' },
              extendEnv: false,
              reject: false,
              timeout: PREFLIGHT_TIMEOUT_MS,
            },
          );
          const output = `${result.stdout}\n${result.stderr}`;
          const parsed = JSON.parse(result.stdout) as {
            ok: boolean;
            error: { code: string; message: string; details: string[] };
          };

          return {
            exitCode: result.exitCode,
            ok: parsed.ok,
            code: parsed.error.code,
            message: parsed.error.message,
            details: parsed.error.details,
            leaked: [token, body, narrowed, sprites ?? ''].some(
              (secret) => secret !== '' && output.includes(secret),
            ),
            created: await inventory.hasWorkstation(name),
          };
        };
        const refused = {
          exitCode: 1,
          ok: false,
          code: 'INPUT',
          message: 'Provider prerequisites are missing or misconfigured',
          leaked: false,
          created: false,
        };

        const nothing = await attempt('none', withNode, {});
        const noFlyctl = await attempt('nofly', withNode, {
          [FLY_TOKEN_VARIABLE]: token,
        });
        const noToken = await attempt('notoken', withFly, {});
        const deploy = await attempt('narrow', withFly, {
          [FLY_TOKEN_VARIABLE]: narrowed,
        });
        const wrongProvider = await attempt('sprites', withFly, {
          [FLY_TOKEN_VARIABLE]: sprites ?? '',
        });

        expect(nothing).toEqual({
          ...refused,
          details: [
            expect.stringMatching(
              /fly is not on PATH.*fly\.io\/docs\/flyctl\/install/u,
            ),
            expect.stringMatching(
              /Fly organization token is not set.*FLY_API_TOKEN/u,
            ),
          ],
        });
        expect(noFlyctl).toEqual({
          ...refused,
          details: [
            expect.stringMatching(
              /fly is not on PATH.*fly\.io\/docs\/flyctl\/install/u,
            ),
          ],
        });
        expect(noToken).toEqual({
          ...refused,
          details: [
            expect.stringMatching(
              /Fly organization token is not set.*FLY_API_TOKEN/u,
            ),
          ],
        });
        expect(deploy).toEqual({
          ...refused,
          details: [
            expect.stringMatching(
              /FLY_API_TOKEN.* is narrowed by its \w+ caveat.*fly tokens create org/u,
            ),
          ],
        });
        expect(wrongProvider).toEqual({
          ...refused,
          details: [expect.stringContaining('holds a Sprites API token')],
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    PREFLIGHT_TEST_TIMEOUT_MS,
  );
});
