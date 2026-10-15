import { execFileSync, spawn } from 'node:child_process';
import {
  appendFile,
  chmod,
  copyFile,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';

import { readTransportNetworks } from '../../../../guest/component-catalog.js';
import { GUEST_ROOT } from '../../../../guest/guest-root.js';

import { resolveTrustedFile } from '../../../../guest/native-files.js';
import { isRecord } from '../../../../guest/records.js';

import {
  TAILSCALE_SOCKET,
  TAILSCALE_STATE_DIRECTORY,
  TAILSCALE_STATE_FILE,
  ensureTailscaleDirectories,
} from './tailscale-state.js';

const stateDirectory = TAILSCALE_STATE_DIRECTORY;
const managedResolver = `${stateDirectory}/open-agent-resolv.conf`;
const originalResolver = `${stateDirectory}/open-agent-provider-resolv.conf`;
const ownedRules = `${stateDirectory}/open-agent-transport-rules`;
const priority = 5200;
// `ip rule show` omits the prefix length of a host destination
const hostLengths = { '-4': 32, '-6': 128 } as const;
const resolverMode = 0o644;
const privateMode = 0o600;
const commandTimeoutMs = 30_000;

if (process.argv[2] === '--restore') {
  await restore();
} else {
  await prepare();
  if (process.argv[2] !== '--prepare') {
    await supervise();
  }
}

/**
 * compares inode identity to avoid unmounting another resolver
 * @returns whether the active resolver is the managed bind mount
 */
async function sameResolver(): Promise<boolean> {
  try {
    const [active, managed] = await Promise.all([
      stat('/etc/resolv.conf'),
      stat(managedResolver),
    ]);

    return active.dev === managed.dev && active.ino === managed.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }

    return false;
  }
}

/** restores only the resolver and routing exceptions recorded by this manager */
async function restore(): Promise<void> {
  if (await sameResolver()) {
    await run('/usr/bin/umount', ['/etc/resolv.conf']);
  }
  const rules = await readFile(ownedRules, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }

    return '';
  });
  for (const line of rules.trim().split('\n').filter(Boolean)) {
    const [family, address, ...rest] = line.split(' ');
    if ((family !== '-4' && family !== '-6') || !address || rest.length > 0) {
      throw new Error('Managed transport rule is malformed');
    }
    // a cold boot drops the kernel's rules but keeps this record
    if (!(await isTransportRuleInstalled(family, address))) {
      continue;
    }
    await run('/usr/sbin/ip', [
      family,
      'rule',
      'del',
      'priority',
      String(priority),
      'to',
      address,
      'lookup',
      'main',
    ]);
  }
  if (rules) {
    await writeFile(ownedRules, '');
  }
}

/** retains provider resolver transport while allowing native Tailscale DNS updates */
async function prepare(): Promise<void> {
  // a cold boot of a provider that discards its root filesystem loses the
  // run directory, and a first start has no state directory yet
  await ensureTailscaleDirectories();
  if (!(await sameResolver())) {
    await copyFile('/etc/resolv.conf', originalResolver);
    await writeFile(
      managedResolver,
      withoutComments(await readFile(originalResolver, 'utf8')),
    );
    await Promise.all([
      chmod(originalResolver, resolverMode),
      chmod(managedResolver, resolverMode),
    ]);
    await run('/usr/bin/mount', [
      '--bind',
      managedResolver,
      '/etc/resolv.conf',
    ]);
  }
  // write in place to preserve the inode held by the bind mount
  await writeFile(
    managedResolver,
    withoutComments(await readFile(managedResolver, 'utf8')),
  );
  await appendFile(ownedRules, '', { mode: 0o600 });
  await chmod(ownedRules, privateMode);
  await prepareTransportRules();
}

/** records only newly installed provider DNS and declared network transport exceptions */
async function prepareTransportRules(): Promise<void> {
  const original = await readFile(originalResolver, 'utf8');
  for (const line of original.split('\n')) {
    const match = /^\s*nameserver\s+(\S+)/.exec(line);
    if (match) {
      await installTransportRule(match[1]!);
    }
  }
  // the root-owned catalog is the only trusted source of the declared networks
  for (const network of await readTransportNetworks()) {
    await installTransportRule(network);
  }
}

/**
 * routes one destination through the main table ahead of any tunnel and records
 * the rule so only this manager removes it; an installed rule is left alone
 * @param destination host address or CIDR prefix, as `ip rule` accepts it
 */
async function installTransportRule(destination: string): Promise<void> {
  const [address = ''] = destination.split('/');
  const family = address.includes(':') ? '-6' : '-4';
  if (await isTransportRuleInstalled(family, destination)) {
    return;
  }
  await run('/usr/sbin/ip', [
    family,
    'rule',
    'add',
    'priority',
    String(priority),
    'to',
    destination,
    'lookup',
    'main',
  ]);
  const record = `${family} ${destination}`;
  if (!(await readFile(ownedRules, 'utf8')).split('\n').includes(record)) {
    await appendFile(ownedRules, `${record}\n`);
  }
}

/**
 * tells whether the kernel holds the main-table rule for a destination
 * @param family `-4` or `-6`
 * @param destination host address or CIDR prefix, as `ip rule` accepts it
 * @returns whether the rule is installed
 */
async function isTransportRuleInstalled(
  family: '-4' | '-6',
  destination: string,
): Promise<boolean> {
  const [address = '', length] = destination.split('/');
  const rules: unknown = JSON.parse(
    await run('/usr/sbin/ip', [family, '-j', 'rule', 'show']),
  );
  if (!Array.isArray(rules)) {
    throw new Error('Native route response is malformed');
  }
  const hostLength = hostLengths[family];
  const wantedLength = length === undefined ? hostLength : Number(length);

  return rules
    .filter(isRecord)
    .some(
      (rule) =>
        rule.priority === priority &&
        rule.dst === address &&
        (rule.dstlen ?? hostLength) === wantedLength &&
        rule.table === 'main',
    );
}

/**
 * removes provider comments without changing nameserver directives
 * @param contents original resolver text
 * @returns uncommented resolver text
 */
function withoutComments(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * executes a trusted system network tool with bounded output
 * @param executable fixed system path
 * @param args direct arguments
 * @returns captured command output
 */
async function run(executable: string, args: string[]): Promise<string> {
  return execFileSync(await resolveTrustedFile(executable), args, {
    encoding: 'utf8',
    timeout: commandTimeoutMs,
  });
}

/** forwards service signals and completion to the supervised native daemon */
async function supervise(): Promise<void> {
  const child = spawn(
    await resolveTrustedFile(`${GUEST_ROOT}/tools/tailscaled`),
    [
      `--state=${TAILSCALE_STATE_FILE}`,
      `--socket=${TAILSCALE_SOCKET}`,
      '--tun=tailscale0',
    ],
    { stdio: 'inherit' },
  );
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => child.kill(signal));
  }
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
      resolve();
    });
  });
}
