import { CommandFault } from '#errors';
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

import type { Sprite } from '@fly/sprites';

import type { GitIdentity } from '#input/types';

const GITHUB_DIAGNOSTIC_LIMIT = 1200;

/**
 * sets the selected Git and Jujutsu identity for the non-root runtime account
 * @param sprite target guest
 * @param identity selected author and committer identity
 */
export async function configureGit(
  sprite: Sprite,
  identity: GitIdentity,
): Promise<void> {
  await withGuestTransaction(sprite, async () => {
    const settings = [
      ['user.name', identity.authorName],
      ['user.email', identity.authorEmail],
      ['user.useConfigOnly', 'true'],
    ];
    for (const [key, value] of settings) {
      await runAsAgent(sprite, ['git', 'config', '--global', key!, value!]);
    }
    await runAsAgent(sprite, [
      'jj',
      'config',
      'set',
      '--user',
      'user.name',
      identity.authorName,
    ]);
    await runAsAgent(sprite, [
      'jj',
      'config',
      'set',
      '--user',
      'user.email',
      identity.authorEmail,
    ]);
    await ensurePrivateDirectory(sprite, `${HOME}/.config/agent-sprite`);
    await writeOwnedFile(
      sprite,
      `${HOME}/.config/agent-sprite/committer.json`,
      `${JSON.stringify({ name: identity.committerName, email: identity.committerEmail })}\n`,
    );
  });
}

/**
 * authenticates GitHub CLI using a selected credential over stdin
 * configures separate protected stores for T3 and the provider shell
 * @param sprite target guest
 * @param token GitHub credential passed privately to the native CLI
 * @param hostname selected GitHub host
 */
export async function configureGithub(
  sprite: Sprite,
  token: string,
  hostname = 'github.com',
): Promise<void> {
  await withGuestTransaction(sprite, async () => {
    rememberSecret(token);
    for (const user of [USER, 'sprite']) {
      const home = `/home/${user}`;
      await ensurePrivateDirectory(sprite, `${home}/.config`, user);
      await ensurePrivateDirectory(sprite, `${home}/.config/gh`, user);
      await runGithubCommand({
        sprite,
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
        sprite,
        user,
        args: ['auth', 'setup-git', '--hostname', hostname],
      });
      await runGithubCommand({
        sprite,
        user,
        args: ['auth', 'status', '--hostname', hostname],
      });
    }
  });
}

/**
 * stores only explicitly requested application runtime variables
 * @param sprite target guest
 * @param environment approved runtime variables
 */
export async function configureRuntimeEnv(
  sprite: Sprite,
  environment: Record<string, string>,
): Promise<void> {
  await withGuestTransaction(sprite, async () => {
    const forbidden =
      /^(?:SPRITES_TOKEN|TAILSCALE_API_KEY|TAILSCALE_AUTH_KEY|CLIPROXYAPI_API_KEY|GH_TOKEN|GITHUB_TOKEN|HOME|PATH|CODEX_HOME|CLAUDE_CONFIG_DIR|NODE_OPTIONS|LD_PRELOAD)$/;
    const names = Object.keys(environment);
    const rejected = names.filter((name) => forbidden.test(name));
    if (rejected.length) {
      throw new CommandFault({
        code: 'INPUT',
        message: `Runtime environment contains restricted keys: ${rejected.join(', ')}`,
      });
    }
    await ensurePrivateDirectory(sprite, `${HOME}/.config/agent-sprite`);
    await writeOwnedFile(
      sprite,
      `${HOME}/.config/agent-sprite/runtime-env.json`,
      `${JSON.stringify(environment)}\n`,
    );
  });
}

/**
 * runs native GitHub authentication with bounded, redacted failure details
 * @param params guest account, native arguments and optional stdin credential
 * @param params.sprite target guest
 * @param params.user non-root account receiving native GitHub configuration
 * @param params.args native GitHub arguments without credentials
 * @param params.token optional credential delivered only through stdin
 * @throws {Error} when native authentication, Git setup or status verification fails
 */
async function runGithubCommand(params: {
  sprite: Sprite;
  user: string;
  args: string[];
  token?: string;
}): Promise<void> {
  const { sprite, user, args, token } = params;
  const result = await runGuestResult(
    sprite,
    [
      '/usr/sbin/runuser',
      '-u',
      user,
      '--',
      '/usr/bin/env',
      `--chdir=/home/${user}`,
      `HOME=/home/${user}`,
      'PATH=/usr/local/bin:/usr/bin:/bin',
      '/opt/agent-sprite/tools/gh',
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
