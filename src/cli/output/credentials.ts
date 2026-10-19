import { mapValues, projectFields, same } from './fields';

import type { CredentialSaveResult } from '#domain/credentials';

/** where a credential was stored and why the keychain was bypassed */
export interface CredentialSaveOutput {
  storage: string;
  fallbackReason?: string;
}

/** credential saves by management credential name */
export type RetainedCredentialsOutput = Record<string, CredentialSaveOutput>;

/**
 * projects one credential storage outcome
 * @param saved internal storage outcome
 * @returns output credential storage outcome
 */
export function projectCredentialSave(
  saved: CredentialSaveResult,
): CredentialSaveOutput {
  return projectFields<CredentialSaveResult, CredentialSaveOutput>(saved, {
    storage: same,
    fallbackReason: same,
  });
}

/**
 * projects the credentials a command retained, by name
 * @param retained internal storage outcomes
 * @returns output storage outcomes
 */
export function projectRetainedCredentials(
  retained: Readonly<Partial<Record<string, CredentialSaveResult>>>,
): RetainedCredentialsOutput {
  return mapValues(projectCredentialSave)(retained);
}
