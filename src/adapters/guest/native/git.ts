import {
  USER,
  ensurePrivateDirectory,
  runAsAgent,
  writeOwnedFile,
} from '#adapters/guest/platform/account';
import {
  ACCOUNT_PATH,
  AGENT_CONFIG,
  COMMITTER_PATH,
  RUNTIME_ENV_PATH,
  accountHome,
} from '#adapters/guest/platform/layout';
import { runGuestResult } from '#adapters/guest/platform/run';
import { HOMEBREW_GH } from '#adapters/guest/tools/accounts';
import {
  driverCredentialNames,
  harnessEnvironmentNames,
} from '#domain/environment-names';
import { HARNESS_IDS } from '#domain/ids';
import { CommandFault } from '#kernel/faults';
import { redactResolved, rememberSecret } from '#kernel/redaction';

import { configureShellEnv } from './shell-env';

import type { GithubTarget } from '#application/ports/guest';
import type { GuestChannel } from '#application/ports/guest-channel';
import type { ProductDeclarations } from '#domain/declarations';
import type { GitIdentity } from '#domain/git';
import type { Secret } from '#kernel/secret';

const GITHUB_DIAGNOSTIC_LIMIT = 1200;

/** approved runtime variables and the shell accounts that also read them */
export interface RuntimeEnvTarget {
  /** approved runtime variables */
  environment: Record<string, string>;
  /** provider shell accounts whose shells also read them */
  shellAccounts: readonly string[];
}

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
  await ensurePrivateDirectory(guest, AGENT_CONFIG);
  await writeOwnedFile(
    guest,
    COMMITTER_PATH,
    `${JSON.stringify({ name: identity.committerName, email: identity.committerEmail })}\n`,
  );
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
    const home = accountHome(user);
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
 * stores only explicitly requested application runtime variables, for the
 * agent service and for every shell of the agent and the provider shell
 * accounts; each value is registered for redaction, as it is and as JSON
 * escapes it, so the files reach the guest as secret inputs
 * @param declarations the data every registered driver declares
 * @param guest target guest
 * @param target approved runtime variables and the provider shell accounts
 */
export async function configureRuntimeEnv(
  declarations: ProductDeclarations,
  guest: GuestChannel,
  target: RuntimeEnvTarget,
): Promise<void> {
  const { environment, shellAccounts } = target;
  assertRuntimeEnv(declarations, environment);
  for (const value of Object.values(environment)) {
    rememberSecret(value);
    // JSON escapes a quote, a backslash or a control character in the value
    rememberSecret(JSON.stringify(value).slice(1, -1));
  }
  await ensurePrivateDirectory(guest, AGENT_CONFIG);
  await writeOwnedFile(
    guest,
    RUNTIME_ENV_PATH,
    `${JSON.stringify(environment)}\n`,
  );
  await configureShellEnv(guest, environment, shellAccounts);
}

/**
 * refuses runtime variables that would override a credential, the
 * environment open-agent sets or the OA_* names its guest programs reserve,
 * so create can refuse them before it provisions
 * @param declarations the data every registered driver declares
 * @param environment requested runtime variables
 * @throws {CommandFault} when a variable is restricted or reserved
 */
export function assertRuntimeEnv(
  declarations: ProductDeclarations,
  environment: Record<string, string>,
): void {
  const forbidden = new Set([
    ...driverCredentialNames(declarations),
    ...harnessEnvironmentNames(declarations, HARNESS_IDS),
    declarations.gateways.cliproxyapi.inputs.apiKey.environment,
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'HOME',
    'PATH',
    'NODE_OPTIONS',
    'LD_PRELOAD',
  ]);
  const names = Object.keys(environment);
  const malformed = names.filter((name) => !/^[A-Z_a-z]\w*$/.test(name));
  if (malformed.length) {
    throw new CommandFault({
      code: 'INPUT',
      message: `Runtime environment contains names a shell cannot export: ${malformed.join(', ')}`,
    });
  }
  const rejected = names.filter((name) => forbidden.has(name));
  if (rejected.length) {
    throw new CommandFault({
      code: 'INPUT',
      message: `Runtime environment contains restricted keys: ${rejected.join(', ')}`,
    });
  }
  const reserved = names.filter((name) => name.startsWith('OA_'));
  if (reserved.length) {
    throw new CommandFault({
      code: 'INPUT',
      message: `Runtime environment contains keys open-agent reserves for its guest programs: ${reserved.join(', ')}; rename them without the OA_ prefix`,
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
  const home = accountHome(user);
  const result = await runGuestResult(
    guest,
    [
      '/usr/sbin/runuser',
      '-u',
      user,
      '--',
      '/usr/bin/env',
      `--chdir=${home}`,
      `HOME=${home}`,
      `PATH=${ACCOUNT_PATH}`,
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
