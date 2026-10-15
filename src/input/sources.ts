import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'dotenv';

import { catalog } from '#core/catalog';
import { harnessEnvironmentNames } from '#core/environment';
import { networksWithInputs } from '#core/networks';
import { SELECTION_INPUTS } from '#core/selection-inputs';
import { CLIPROXYAPI_INPUTS } from '#drivers/shared/cliproxyapi/inputs';
import { CommandFault } from '#errors';
import { checkOperation } from '#operation';

import { readInputFile } from '#utilities/input-file';
import { runLocal } from '#utilities/process';
import { rememberSecret } from '#utilities/redaction';

import type { CommandOptions } from '#command/contracts';

export interface InputSources {
  processEnv: NodeJS.ProcessEnv;
  fileEnv: Record<string, string>;
  profile: Record<string, string>;
}

const RESERVED_ENV = new Set([
  ...Object.values(catalog.providers).map(
    ({ prerequisites }) => prerequisites.credential.environment,
  ),
  ...networksWithInputs().flatMap(({ inputs }) =>
    Object.values(inputs).map(({ environment }) => environment),
  ),
  ...Object.values(SELECTION_INPUTS).map(({ environment }) => environment),
  ...Object.values(CLIPROXYAPI_INPUTS).map(({ environment }) => environment),
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'NON_INTERACTIVE',
  'CI',
  'TERM',
  'NO_COLOR',
]);
/** non-secret values the local input profile may hold */
const PROFILE_KEYS = new Set([
  ...networksWithInputs().flatMap(({ inputs }) => [
    inputs.account.environment,
    inputs.exitNode.environment,
  ]),
  CLIPROXYAPI_INPUTS.baseUrl.environment,
]);
const REJECTED_ENV = new Set([
  'HOME',
  'PATH',
  'SHELL',
  'IFS',
  'ENV',
  'BASH_ENV',
  'CDPATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYOPT',
  'PERL5OPT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  ...harnessEnvironmentNames(),
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
]);

const KEYCHAIN_REFERENCE_PARTS = 2;

/**
 * filters a dotenv file to runtime variables safe to forward to the guest
 * @param fileEnv parsed entries from the selected dotenv file
 * @returns variables permitted in the guest runtime environment
 */
export function runtimeEnvironment(
  fileEnv: Record<string, string>,
): Record<string, string> {
  const conflicts = Object.keys(fileEnv).filter(
    (name) =>
      REJECTED_ENV.has(name) ||
      /^(?:DYLD_|LD_|GIT_CONFIG_|NPM_CONFIG_)/i.test(name),
  );
  if (conflicts.length > 0) {
    throw new CommandFault({
      code: 'INPUT',
      message: `Unsupported runtime environment overrides: ${conflicts.join(', ')}`,
    });
  }

  const selected = Object.fromEntries(
    Object.entries(fileEnv).filter(([name]) => !RESERVED_ENV.has(name)),
  );
  Object.values(selected).forEach(rememberSecret);

  return selected;
}

/**
 * reads process, selected dotenv, and non-secret profile values
 * @param options parsed environment-file option
 * @returns sources in documented precedence order
 */
export async function readInputSources(
  options: CommandOptions,
): Promise<InputSources> {
  const environment = await readEnvironmentSources(options);
  const profilePath = join(homedir(), '.config', 'open-agent', 'profile.json');
  const profileText = await readInputFile(profilePath).catch(
    (error: NodeJS.ErrnoException) => {
      checkOperation();
      if (error.code === 'ENOENT') {
        return '{}';
      }
      throw new CommandFault({
        code: 'INPUT',
        message: 'The local input profile must be a readable regular file.',
        cause: error,
      });
    },
  );
  const profileValue: unknown = parseProfile(profileText);
  if (
    typeof profileValue !== 'object' ||
    profileValue === null ||
    Array.isArray(profileValue)
  ) {
    throw new CommandFault({
      code: 'INPUT',
      message: `Invalid non-secret profile: ${profilePath}`,
    });
  }
  const profile = Object.fromEntries(
    Object.entries(profileValue).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && PROFILE_KEYS.has(entry[0]),
    ),
  );

  return { ...environment, profile };
}

/**
 * reads credential environment sources without unrelated integration profiles
 * @param options explicitly selected dotenv file
 * @returns process and file values in credential precedence order
 */
export async function readEnvironmentSources(
  options: CommandOptions,
): Promise<Pick<InputSources, 'processEnv' | 'fileEnv'>> {
  const fileEnv = options.env
    ? parse(await readInputText(options.env, '--env file'))
    : {};

  return { processEnv: process.env, fileEnv };
}

/**
 * resolves an explicit local secret reference or fallback value
 * @param reference optional environment, file, or keychain reference
 * @param fallback value from lower-precedence sources
 * @returns the selected secret without printing it
 */
export async function resolveSecret(
  reference: string | undefined,
  fallback: string | undefined,
): Promise<string | undefined> {
  if (!reference) {
    return registerResolved(fallback?.length ? fallback : undefined);
  }
  if (reference.startsWith('env:')) {
    const name = reference.slice('env:'.length);
    const value = process.env[name];
    if (!value) {
      throw new CommandFault({
        code: 'INPUT',
        message: `Environment variable ${JSON.stringify(name)} is empty or unset.`,
      });
    }

    return registerResolved(value);
  }
  if (reference.startsWith('file:')) {
    const path = reference.slice('file:'.length);
    const value = (await readInputText(path, 'secret file')).trimEnd();
    if (!value) {
      throw new CommandFault({
        code: 'INPUT',
        message: `Secret file ${JSON.stringify(path)} is empty.`,
      });
    }

    return registerResolved(value);
  }
  if (reference.startsWith('keychain:')) {
    const [service, account] = reference
      .slice('keychain:'.length)
      .split('/', KEYCHAIN_REFERENCE_PARTS);
    if (!service || !account) {
      throw new CommandFault({
        code: 'INPUT',
        message: 'Keychain reference must be keychain:service/account',
      });
    }

    const value = await runLocal({
      program: 'security',
      arguments: ['find-generic-password', '-s', service, '-a', account, '-w'],
    }).catch((cause: unknown) => {
      checkOperation();
      throw new CommandFault({
        code: 'INPUT',
        message: 'Selected keychain secret source could not be read.',
        cause,
      });
    });

    return registerResolved(value);
  }
  throw new CommandFault({
    code: 'INPUT',
    message:
      'Secret source must be env:NAME, file:PATH, or keychain:SERVICE/ACCOUNT',
  });
}

/**
 * registers a successfully selected secret before it leaves its source
 * @param value selected credential, if available
 * @returns the same selected credential
 */
function registerResolved(value: string | undefined): string | undefined {
  rememberSecret(value);

  return value;
}

/**
 * classifies selected local files as input faults without disclosing their contents
 * @param path explicitly selected environment or secret file
 * @param source selected file kind for a safe diagnostic
 * @returns complete local input text
 */
async function readInputText(path: string, source: string): Promise<string> {
  try {
    return await readInputFile(path);
  } catch (cause) {
    checkOperation();
    throw new CommandFault({
      code: 'INPUT',
      message: `Selected ${source} ${JSON.stringify(path)} must be a readable regular file.`,
      cause,
      causeVisibility: 'private',
    });
  }
}

/**
 * parses the local non-secret profile with a typed input boundary
 * @param text local profile JSON
 * @returns parsed profile for structural validation
 */
function parseProfile(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new CommandFault({
      code: 'INPUT',
      message: 'The local input profile is not valid JSON.',
      cause,
    });
  }
}
