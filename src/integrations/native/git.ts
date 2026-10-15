import {
  driverCredentialNames,
  harnessEnvironmentNames,
} from '#core/environment';
import { CLIPROXYAPI_INPUTS } from '#drivers/shared/cliproxyapi/inputs';
import { CommandFault } from '#errors';
import { HOMEBREW } from '#guest/homebrew';
import { runGuestResult } from '#integrations/guest';
import { withGuestTransaction } from '#integrations/guest/transaction';
import { rememberSecret, redactResolved } from '#utilities/redaction';

import {
  USER,
  HOME,
  ensurePrivateDirectory,
  runAsAgent,
  writeOwnedFile,
} from './configuration.js';

import type { GuestChannel } from '#drivers/guest-channel';

import type { GitIdentity } from '#input/types';

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
  await withGuestTransaction(guest, async () => {
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
  });
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
 * @param guest target guest
 * @param token GitHub credential passed privately to the native CLI
 * @param target selected GitHub host and provider shell accounts
 */
export async function configureGithub(
  guest: GuestChannel,
  token: string,
  target: GithubTarget,
): Promise<void> {
  const hostname = target.hostname ?? 'github.com';
  await withGuestTransaction(guest, async () => {
    rememberSecret(token);
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
  });
}

/**
 * stores only explicitly requested application runtime variables
 * @param guest target guest
 * @param environment approved runtime variables
 */
export async function configureRuntimeEnv(
  guest: GuestChannel,
  environment: Record<string, string>,
): Promise<void> {
  await withGuestTransaction(guest, async () => {
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
    await ensurePrivateDirectory(guest, `${HOME}/.config/open-agent`);
    await writeOwnedFile(
      guest,
      `${HOME}/.config/open-agent/runtime-env.json`,
      `${JSON.stringify(environment)}\n`,
    );
  });
}

/**
 * runs native GitHub authentication with bounded, redacted failure details
 * @param params guest account, native arguments and optional stdin credential
 * @param params.guest target guest channel
 * @param params.user non-root account receiving native GitHub configuration
 * @param params.args native GitHub arguments without credentials
 * @param params.token optional credential delivered only through stdin
 * @throws {Error} when native authentication, Git setup or status verification fails
 */
async function runGithubCommand(params: {
  guest: GuestChannel;
  user: string;
  args: string[];
  token?: string;
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
      'PATH=/usr/local/bin:/usr/bin:/bin',
      // the bottle's keg, which only the Homebrew account can change
      HOMEBREW.gh,
      ...args,
    ],
    { input: token ? `${token}\n` : undefined },
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
