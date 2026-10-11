import { execFileSync, spawn } from 'node:child_process';
import {
  appendFile,
  chmod,
  copyFile,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';

import { resolveTrustedFile } from './native-files.js';
import { isRecord } from './records.js';

const stateDirectory = '/var/lib/tailscale';
const managedResolver = `${stateDirectory}/agent-sprite-resolv.conf`;
const originalResolver = `${stateDirectory}/agent-sprite-provider-resolv.conf`;
const ownedRules = `${stateDirectory}/agent-sprite-transport-rules`;
const priority = 5200;
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
    const [family, address] = line.split(' ');
    if (
      !['-4', '-6'].includes(family ?? '') ||
      !address ||
      line.split(' ').length !== 2
    ) {
      throw new Error('Managed transport rule is malformed');
    }
    await run('/usr/sbin/ip', [
      family!,
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

/** records only newly installed provider DNS transport exceptions */
async function prepareTransportRules(): Promise<void> {
  const original = await readFile(originalResolver, 'utf8');
  for (const line of original.split('\n')) {
    const match = /^\s*nameserver\s+(\S+)/.exec(line);
    if (!match) {
      continue;
    }
    const address = match[1]!;
    const family = address.includes(':') ? '-6' : '-4';
    const rules: unknown = JSON.parse(
      await run('/usr/sbin/ip', [family, '-j', 'rule', 'show']),
    );
    if (!Array.isArray(rules)) {
      throw new Error('Native route response is malformed');
    }
    if (
      rules
        .filter(isRecord)
        .some(
          (rule) =>
            rule.priority === priority &&
            rule.dst === address &&
            rule.table === 'main',
        )
    ) {
      continue;
    }
    await run('/usr/sbin/ip', [
      family,
      'rule',
      'add',
      'priority',
      String(priority),
      'to',
      address,
      'lookup',
      'main',
    ]);
    const record = `${family} ${address}`;
    if (!(await readFile(ownedRules, 'utf8')).split('\n').includes(record)) {
      await appendFile(ownedRules, `${record}\n`);
    }
  }
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
    await resolveTrustedFile('/opt/agent-sprite/tools/tailscaled'),
    [
      '--state=/var/lib/tailscale/tailscaled.state',
      '--socket=/var/run/tailscale/tailscaled.sock',
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
