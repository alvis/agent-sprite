import {
  driverCredentialNames,
  harnessEnvironmentNames,
} from '#core/environment';
import { CLIPROXYAPI_INPUTS } from '#drivers/shared/cliproxyapi/inputs';
import { CommandFault } from '#errors';
import { runGuestResult } from '#integrations/guest';
import { HOMEBREW_PATH } from '#integrations/guest/layout';
import { HOMEBREW_GH } from '#tools/accounts';
import { redactResolved, rememberSecret } from '#utilities/redaction';

import {
  USER,
  HOME,
  ensurePrivateDirectory,
  runAsAgent,
  writeOwnedFile,
} from './configuration.js';

import type { GuestChannel } from '#drivers/guest-channel';
import type { GitIdentity } from '#input/types';
import type { Secret } from '#integrations/guest/session/secret';

const GITHUB_DIAGNOSTIC_LIMIT = 1200;

/**
 * sets the selected Git and Jujutsu identity for the non-root runtime account
 * @param guest target guest
 * @param identity selected author and committer identity
 */
export async function configureGit(
  guest: GuestChannel,
  identity: GitIdentity,
): Promise<void> {
  const settings = [
    ['user.name', identity.authorName],
    ['user.email', identity.authorEmail],
    ['user.useConfigOnly', 'true'],
  ];
  for (const [key, value] of settings) {
    await runAsAgent(guest, ['git', 'config', '--global', key!, value!]);
  }
  await runAsAgent(guest, [
    'jj',
    'config',
    'set',
    '--user',
    'user.name',
    identity.authorName,
  ]);
  await runAsAgent(guest, [
    'jj',
    'config',
    'set',
    '--user',
    'user.email',
    identity.authorEmail,
  ]);
  await ensurePrivateDirectory(guest, `${HOME}/.config/open-agent`);
  await writeOwnedFile(
    guest,
    `${HOME}/.config/open-agent/committer.json`,
    `${JSON.stringify({ name: identity.committerName, email: identity.committerEmail })}\n`,
  );
}

/** where GitHub CLI is authenticated */
export interface GithubTarget {
  /** selected GitHub host; github.com when absent */
  hostname?: string;
  /** provider shell accounts that share the agent account's login */
  shellAccounts: readonly string[];
}

/**
 * authenticates GitHub CLI using a selected credential over stdin
 * configures separate protected stores for the agent and each provider shell account
 * @param guest target guest, running over a setup session
 * @param token GitHub credential, piped to the native CLI as session input
 * @param target selected GitHub host and provider shell accounts
 */
export async function configureGithub(
  guest: GuestChannel,
  token: Secret,
  target: GithubTarget,
): Promise<void> {
  const hostname = target.hostname ?? 'github.com';
  for (const user of [USER, ...target.shellAccounts]) {
    const home = `/home/${user}`;
    const owner = { user, shellAccounts: target.shellAccounts };
    await ensurePrivateDirectory(guest, `${home}/.config`, owner);
    await ensurePrivateDirectory(guest, `${home}/.config/gh`, owner);
    await runGithubCommand({
      guest,
      user,
      args: [
        'auth',
        'login',
        '--hostname',
        hostname,
        '--git-protocol',
        'https',
        '--with-token',
      ],
      token,
    });
    await runGithubCommand({
      guest,
      user,
      args: ['auth', 'setup-git', '--hostname', hostname],
    });
    await runGithubCommand({
      guest,
      user,
      args: ['auth', 'status', '--hostname', hostname],
    });
  }
}

/**
 * stores only explicitly requested application runtime variables; each value
 * is registered for redaction, so the file reaches the guest as a secret input
 * @param guest target guest
 * @param environment approved runtime variables
 */
export async function configureRuntimeEnv(
  guest: GuestChannel,
  environment: Record<string, string>,
): Promise<void> {
  assertRuntimeEnv(environment);
  Object.values(environment).forEach(rememberSecret);
  await ensurePrivateDirectory(guest, `${HOME}/.config/open-agent`);
  await writeOwnedFile(
    guest,
    `${HOME}/.config/open-agent/runtime-env.json`,
    `${JSON.stringify(environment)}\n`,
  );
}

/**
 * refuses runtime variables that would override a credential or the
 * environment open-agent sets, so create can refuse them before it provisions
 * @param environment requested runtime variables
 * @throws {CommandFault} when a variable is restricted
 */
export function assertRuntimeEnv(environment: Record<string, string>): void {
  const forbidden = new Set([
    ...driverCredentialNames(),
    ...harnessEnvironmentNames(),
    CLIPROXYAPI_INPUTS.apiKey.environment,
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'HOME',
    'PATH',
    'NODE_OPTIONS',
    'LD_PRELOAD',
  ]);
  const names = Object.keys(environment);
  const rejected = names.filter((name) => forbidden.has(name));
  if (rejected.length) {
    throw new CommandFault({
      code: 'INPUT',
      message: `Runtime environment contains restricted keys: ${rejected.join(', ')}`,
    });
  }
}

/**
 * runs native GitHub authentication with bounded, redacted failure details
 * @param params guest account, native arguments and optional stdin credential
 * @param params.guest target guest channel
 * @param params.user non-root account receiving native GitHub configuration
 * @param params.args native GitHub arguments without credentials
 * @param params.token optional credential delivered only as session input on stdin
 * @throws {Error} when native authentication, Git setup or status verification fails
 */
async function runGithubCommand(params: {
  guest: GuestChannel;
  user: string;
  args: string[];
  token?: Secret;
}): Promise<void> {
  const { guest, user, args, token } = params;
  const result = await runGuestResult(
    guest,
    [
      '/usr/sbin/runuser',
      '-u',
      user,
      '--',
      '/usr/bin/env',
      `--chdir=/home/${user}`,
      `HOME=/home/${user}`,
      `PATH=${HOMEBREW_PATH}:/usr/local/bin:/usr/bin:/bin`,
      // the bottle's keg, which only the Homebrew account can change
      HOMEBREW_GH,
      ...args,
    ],
    token ? { secret: { value: token, as: 'stdin' } } : {},
  );
  if (result.exitCode !== 0) {
    const detail = redactResolved(result.stderr)
      .replace(/\p{Cc}/gu, ' ')
      .trim()
      .slice(0, GITHUB_DIAGNOSTIC_LIMIT);
    const explanation = detail ? ': ' + detail : '.';
    throw new CommandFault({
      code: 'PROVIDER',
      message: `GitHub (${user}) ${args.join(' ')} failed (exit ${result.exitCode})${explanation}`,
    });
  }
}
