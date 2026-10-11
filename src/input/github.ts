import { stderr } from 'node:process';

import { CommandFault } from '#errors';
import { returnOnBack, withBackNavigation } from '#navigation';
import { checkOperation, runOperation } from '#operation';
import { runLocal } from '#utilities/process';
import { rememberSecret } from '#utilities/redaction';

import { githubAccount } from './github-account.js';

import type {
  CommandOptions,
  Interaction,
  InteractionChoice,
} from '#command/contracts';

import type { InputSources } from './sources.js';
import type { GitIdentity } from './types.js';

export { discoverGithubToken } from './github-discovery.js';

interface GitIdentityContext {
  options: CommandOptions;
  sources: InputSources;
  githubToken?: string;
  verifiedAccount?: GithubAccount;
  interaction?: Interaction;
}

type GithubAccount = Awaited<ReturnType<typeof githubAccount>>;

/** the source of a token determines whether failed verification may be skipped */
export interface GithubTokenCandidate {
  token: string;
  provenance: 'provided' | 'gh-discovery';
}

/** verified credential and account selected for guest setup and Git identity */
export interface SelectedGithubCredential {
  token: string;
  account: GithubAccount;
}

/**
 * resolves independent Git author and committer identities in precedence order
 * @param context parsed flags, local sources, and optional account context
 * @returns a confirmed identity or undefined when unavailable or declined
 */
export async function resolveGitIdentity(
  context: GitIdentityContext,
): Promise<GitIdentity | undefined> {
  const { options, sources, githubToken, verifiedAccount, interaction } =
    context;
  if (options.gitIdentity === false) {
    return undefined;
  }
  const get = (key: string): string | undefined =>
    [sources.processEnv[key], sources.fileEnv[key]].find((value) =>
      Boolean(value),
    );
  const prompt = options.nonInteractive ? undefined : interaction;
  const local = await localGitIdentity(options.localCredentials === false);
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
 * @param disabled whether local credential discovery is disabled
 * @returns available local name and email fields
 */
async function localGitIdentity(
  disabled: boolean,
): Promise<{ name?: string; email?: string }> {
  if (disabled) {
    return {};
  }
  const [name, email] = await runOperation(async () =>
    Promise.all([
      runLocal({
        program: 'git',
        arguments: ['config', '--global', '--get', 'user.name'],
      }).catch(() => {
        checkOperation();

        return undefined;
      }),
      runLocal({
        program: 'git',
        arguments: ['config', '--global', '--get', 'user.email'],
      }).catch(() => {
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

/**
 * verifies a supplied or discovered credential before optional selection
 * @param candidate token with its direct or gh-discovered provenance
 * @param options parsed interaction mode
 * @param interaction optional inline choice and secret prompts
 * @returns selected token and verified account, if any
 */
export function selectGithubToken(
  candidate: GithubTokenCandidate | undefined,
  options: CommandOptions,
  interaction?: Interaction,
): Promise<SelectedGithubCredential | undefined>;
export function selectGithubToken(
  candidate: string,
  options: CommandOptions,
  interaction?: Interaction,
): Promise<string | undefined>;
export async function selectGithubToken(
  candidate: GithubTokenCandidate | string | undefined,
  options: CommandOptions,
  interaction?: Interaction,
): Promise<SelectedGithubCredential | string | undefined> {
  const wasString = typeof candidate === 'string';
  const source = wasString
    ? { token: candidate, provenance: 'provided' as const }
    : candidate;
  const verified = await verifyGithubCandidate(source, options, interaction);
  const selected =
    !interaction || options.nonInteractive
      ? verified
      : await chooseGithubCredential(verified, options, interaction);

  return wasString ? selected?.token : selected;
}

/**
 * verifies one candidate, dropping only a failed gh discovery
 * @param candidate token with its source provenance
 * @param options selected GitHub host
 * @param interaction optional human diagnostic boundary
 * @returns verified token and account, if any
 */
async function verifyGithubCandidate(
  candidate: GithubTokenCandidate | undefined,
  options: CommandOptions,
  interaction?: Interaction,
): Promise<SelectedGithubCredential | undefined> {
  if (!candidate) {
    return undefined;
  }
  rememberSecret(candidate.token);
  try {
    return {
      token: candidate.token,
      account: await githubAccount(candidate.token, options.githubHost),
    };
  } catch (error) {
    checkOperation();
    if (
      candidate.provenance === 'provided' ||
      (error instanceof CommandFault && error.code === 'INPUT')
    ) {
      throw error;
    }
    reportDroppedDiscovery(interaction);

    return undefined;
  }
}

/**
 * offers the verified credential, replacement, or an intentional skip
 * @param verified candidate verified before the prompt
 * @param options selected GitHub host
 * @param interaction active inline prompts
 * @returns selected credential and account, if any
 */
async function chooseGithubCredential(
  verified: SelectedGithubCredential | undefined,
  options: CommandOptions,
  interaction: Interaction,
): Promise<SelectedGithubCredential | undefined> {
  for (;;) {
    const choice = await interaction.select<'use' | 'replace' | 'skip'>(
      {
        message: verified
          ? `GitHub credential for ${verified.account.login}: use, replace, or skip?`
          : 'GitHub credential: add or skip?',
      },
      [
        ...(verified
          ? [
              {
                value: 'use',
                label: 'Use this credential',
              } satisfies InteractionChoice<'use'>,
            ]
          : []),
        { value: 'replace', label: 'Enter a credential' },
        { value: 'skip', label: 'Skip GitHub access' },
      ],
    );
    if (choice === 'skip') {
      return undefined;
    }
    if (choice === 'use') {
      return verified;
    }
    const replacement = await promptGithubReplacement(options, interaction);
    if (replacement) {
      return replacement;
    }
  }
}

/**
 * reports a discarded gh discovery only on the human diagnostic stream
 * @param interaction active interactive status reporter, when present
 */
function reportDroppedDiscovery(interaction?: Interaction): void {
  const message =
    'The discovered gh credential could not be verified and was discarded.';
  if (interaction) {
    interaction.status({ kind: 'warning', message });
  } else {
    stderr.write(`Warning: ${message}\n`);
  }
}

/**
 * validates a masked replacement without exposing rejected credentials
 * @param options selected GitHub hostname
 * @param interaction active credential prompts
 * @returns verified replacement and account or a return to credential choices
 */
async function promptGithubReplacement(
  options: CommandOptions,
  interaction: Interaction,
): Promise<SelectedGithubCredential | undefined> {
  const replacement = await returnOnBack(async () =>
    withBackNavigation(interaction, 'back to GitHub choices').secret({
      message: 'GitHub token',
      required: true,
    }),
  );
  if (!replacement) {
    return undefined;
  }
  rememberSecret(replacement);
  try {
    const account = await githubAccount(replacement, options.githubHost);

    return { token: replacement, account };
  } catch {
    checkOperation();
    interaction.status({
      kind: 'warning',
      message:
        'The replacement GitHub credential could not be verified. Try another or skip GitHub access.',
    });

    return undefined;
  }
}
