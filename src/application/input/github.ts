import { withBackNavigation } from '#application/navigation';
import { CommandFault } from '#kernel/faults';
import { returnOnBack } from '#kernel/navigation';
import { checkOperation, publishStatus } from '#kernel/operation';
import { rememberSecret } from '#kernel/redaction';

import { githubAccount } from './github-account';

import type { CommandOptions } from '#application/contracts';
import type {
  Interaction,
  InteractionChoice,
} from '#application/ports/interaction';

type GithubAccount = Awaited<ReturnType<typeof githubAccount>>;

/** the source of a token determines whether failed verification may be skipped */
export interface GithubTokenCandidate {
  token: string;
  provenance: 'provided' | 'gh-discovery';
}

/** verified credential and account selected for guest setup and Git identity */
interface SelectedGithubCredential {
  token: string;
  account: GithubAccount;
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
 * reports a discarded gh discovery as a warning status
 * @param interaction active interactive status reporter, when present
 */
function reportDroppedDiscovery(interaction?: Interaction): void {
  const message =
    'The discovered gh credential could not be verified and was discarded.';
  publishStatus({ kind: 'warning', message }, interaction);
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
