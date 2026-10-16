import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import process from 'node:process';

import { refusedCredential } from '#drivers/shared/prerequisites';
import { checkOperation } from '#operation';
import { runLocal } from '#utilities/process';

import { catalog } from './catalog.js';

import type { PrerequisiteProblem } from '#drivers/providers/prerequisites';

import type { ProviderId } from './catalog.js';

/** a provider credential and where it was read from */
interface PreflightCredential {
  /** credential resolved from its declared sources, when found */
  token?: string;
  /** where the credential was read from */
  source?: string;
}

/**
 * runs a provider's preflight before its first provider call
 * @param provider provider whose prerequisites are checked
 * @param credential management credential and the source it was read from
 * @returns every missing or misconfigured prerequisite with its fix
 */
export async function providerPreflight(
  provider: ProviderId,
  credential: PreflightCredential,
): Promise<PrerequisiteProblem[]> {
  return catalog.providers[provider].preflight({
    credential: credential.token,
    credentialSource: credential.source,
    findTool,
    readVersion,
  });
}

/**
 * checks, offline and synchronously, a credential the caller is entering
 * @param provider provider whose declared credential is entered
 * @param token entered value
 * @returns why the value cannot be the provider credential, or undefined when it may be
 */
export function enteredCredentialProblem(
  provider: ProviderId,
  token: string,
): string | undefined {
  const problem = refusedCredential(
    catalog.providers[provider].prerequisites.credential,
    { token },
  );

  return problem && `${problem.problem}. ${problem.fix}`;
}

/**
 * renders prerequisite problems as one detail line each
 * @param problems problems a preflight reported
 * @returns problem and fix per line
 */
export function prerequisiteDetails(
  problems: readonly PrerequisiteProblem[],
): string[] {
  return problems.map(({ problem, fix }) => `${problem}. ${fix}`);
}

/**
 * locates an executable on PATH without running it
 * @param command executable name
 * @returns the absolute path, or undefined when no PATH entry has it
 */
async function findTool(command: string): Promise<string | undefined> {
  const candidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, command));
  const found = await Promise.all(
    candidates.map(async (path) =>
      access(path, constants.X_OK).then(
        () => path,
        () => undefined,
      ),
    ),
  );

  return found.find((path) => path !== undefined);
}

/**
 * runs a tool's version command
 * @param command executable name
 * @param arguments_ arguments that print the version
 * @returns the printed version text, or undefined when the command fails
 */
async function readVersion(
  command: string,
  arguments_: readonly string[],
): Promise<string | undefined> {
  return runLocal({ program: command, arguments: [...arguments_] }).catch(
    () => {
      checkOperation();

      return undefined;
    },
  );
}
