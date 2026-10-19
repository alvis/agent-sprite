import { returnOnBack } from '#kernel/navigation';
import { checkOperation, runOperation } from '#kernel/operation';

import { githubAccount } from './github-account';

import type { CommandOptions } from '#application/contracts';
import type { ApplicationDependencies } from '#application/ports/dependencies';
import type { Interaction } from '#application/ports/interaction';

import type { GitIdentity } from '#domain/git';

import type { InputSources } from './sources';

type GithubAccount = Awaited<ReturnType<typeof githubAccount>>;

interface GitIdentityContext {
  options: CommandOptions;
  sources: InputSources;
  githubToken?: string;
  verifiedAccount?: GithubAccount;
  interaction?: Interaction;
}

/**
 * resolves independent Git author and committer identities in precedence order
 * @param dependencies what this computer provides
 * @param context parsed flags, local sources, and optional account context
 * @returns a confirmed identity or undefined when unavailable or declined
 */
export async function resolveGitIdentity(
  dependencies: Pick<ApplicationDependencies, 'host'>,
  context: GitIdentityContext,
): Promise<GitIdentity | undefined> {
  const { options, sources, githubToken, verifiedAccount, interaction } =
    context;
  if (options.gitIdentity === false) {
    return undefined;
  }
  const get = (key: string): string | undefined =>
    [sources.fileEnv[key], sources.processEnv[key]].find((value) =>
      Boolean(value),
    );
  const prompt = options.nonInteractive ? undefined : interaction;
  const local = await localGitIdentity(
    dependencies,
    options.localCredentials === false,
  );
  const account =
    verifiedAccount ??
    (githubToken
      ? await githubAccount(githubToken, options.githubHost)
      : undefined);
  const authorName = await confirmMissingIdentity(
    options.gitName ?? get('GIT_AUTHOR_NAME') ?? account?.name ?? local.name,
    'Git author name',
    prompt,
  );
  const authorEmail = await confirmMissingIdentity(
    options.gitEmail ??
      get('GIT_AUTHOR_EMAIL') ??
      account?.email ??
      local.email,
    'Git author email',
    prompt,
  );
  if (!authorName || !authorEmail) {
    return undefined;
  }
  const committerName =
    options.gitCommitterName ?? get('GIT_COMMITTER_NAME') ?? authorName;
  const committerEmail =
    options.gitCommitterEmail ?? get('GIT_COMMITTER_EMAIL') ?? authorEmail;
  const identity = { authorName, authorEmail, committerName, committerEmail };

  return prompt ? chooseGitIdentity(identity, prompt) : identity;
}

/**
 * selects, edits, or deliberately skips the discovered Git identity
 * @param identity fully resolved Git identity
 * @param interaction active identity prompts
 * @returns the selected identity or an intentional skip
 */
async function chooseGitIdentity(
  identity: GitIdentity,
  interaction: Interaction,
): Promise<GitIdentity | undefined> {
  let current = identity;
  for (;;) {
    const action = await interaction.select<'keep' | 'edit' | 'skip'>(
      {
        message: 'Git commit identity',
        description: `Author: ${current.authorName} <${current.authorEmail}>\nCommitter: ${current.committerName} <${current.committerEmail}>`,
      },
      [
        { value: 'keep', label: 'Use this identity' },
        { value: 'edit', label: 'Edit author and committer' },
        {
          value: 'skip',
          label: 'Skip Git identity',
          description: 'Preserve any existing guest identity',
        },
      ],
    );
    if (action === 'skip') {
      return undefined;
    }
    if (action === 'keep') {
      return current;
    }
    current = (await editGitIdentity(current, interaction)) ?? current;
  }
}

/**
 * edits prefilled identity fields with previous-field navigation
 * @param identity current identity before editing
 * @param interaction active identity prompts
 * @returns completed edit or back to the identity menu
 */
async function editGitIdentity(
  identity: GitIdentity,
  interaction: Interaction,
): Promise<GitIdentity | undefined> {
  const fields: Array<{ key: keyof GitIdentity; label: string }> = [
    { key: 'authorName', label: 'Git author name' },
    { key: 'authorEmail', label: 'Git author email' },
    { key: 'committerName', label: 'Git committer name' },
    { key: 'committerEmail', label: 'Git committer email' },
  ];
  const edited = { ...identity };
  let index = 0;
  while (index < fields.length) {
    const field = fields[index]!;
    const value = await returnOnBack(async () =>
      interaction.input({
        message: field.label,
        defaultValue: edited[field.key],
        required: true,
        backLabel: index === 0 ? 'back to identity menu' : 'previous field',
      }),
    );
    if (value === undefined) {
      if (index === 0) {
        return undefined;
      }
      index--;
    } else {
      edited[field.key] = value;
      index++;
    }
  }

  return edited;
}

/**
 * reads optional global Git identity from the caller's own machine
 * @param dependencies what this computer provides
 * @param disabled whether local credential discovery is disabled
 * @returns available local name and email fields
 */
async function localGitIdentity(
  dependencies: Pick<ApplicationDependencies, 'host'>,
  disabled: boolean,
): Promise<{ name?: string; email?: string }> {
  if (disabled) {
    return {};
  }
  const [name, email] = await runOperation(async () =>
    Promise.all([
      dependencies.host
        .run({
          program: 'git',
          arguments: ['config', '--global', '--get', 'user.name'],
        })
        .catch(() => {
          checkOperation();

          return undefined;
        }),
      dependencies.host
        .run({
          program: 'git',
          arguments: ['config', '--global', '--get', 'user.email'],
        })
        .catch(() => {
          checkOperation();

          return undefined;
        }),
    ]),
  );

  return { name, email };
}

/**
 * asks for a missing author field only in interactive mode
 * @param value value already resolved from higher-precedence sources
 * @param message inline prompt describing the missing field
 * @param interaction optional active inline prompt
 * @returns resolved or newly entered field
 */
async function confirmMissingIdentity(
  value: string | undefined,
  message: string,
  interaction?: Interaction,
): Promise<string | undefined> {
  if (value || !interaction) {
    return value;
  }

  return interaction.input({ message, required: true });
}
