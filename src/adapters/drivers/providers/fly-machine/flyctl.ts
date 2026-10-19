import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';

import { currentOperation, runOperation } from '#kernel/operation';
import { ProviderFault } from '#kernel/provider-fault';
import { rememberSecret } from '#kernel/redaction';

import { macaroonLocations, PERMISSION_LOCATION } from './token-scope';

/** a Fly macaroon caveat, as flyctl encodes it */
interface Caveat {
  /** caveat type */
  type: string;
  /** caveat body */
  body: unknown;
}

/** the flyctl executable */
export const FLYCTL = 'fly';
const PRIVATE_DIRECTORY_MODE = 0o700;
const FLYCTL_TIMEOUT_MS = 30_000;
/** the token prefix flyctl prints and accepts */
const MACAROON_SCHEME = 'FlyV1 ';
const TOKEN_SEPARATOR = ',';
/** what an app's SSH token may do outside its own app: read only */
const OTHERWISE_READ = 'r';
/** full access to the token's own app and to WireGuard, which SSH needs */
const APP_ACCESS = 'rwcdC';
/** the only mutations an SSH session performs: its certificate and tunnel */
const SSH_MUTATIONS = ['issueCertificate', 'addWireGuardPeer'];
/**
 * the only inherited variables flyctl sees: where to find programs, home and
 * temporary files, the locale, and how to reach the internet; every other
 * variable, the caller's own Fly configuration and tokens included, is dropped
 */
const INHERITED_VARIABLES = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  ...['HTTP', 'HTTPS', 'ALL', 'NO'].flatMap((scheme) => [
    `${scheme}_PROXY`,
    `${scheme.toLowerCase()}_proxy`,
  ]),
]);
/** the locale and XDG base directory variables, inherited too */
const INHERITED_PREFIX = /^(?:LC|XDG)_/u;
/** a derived SSH token: a read permission, a mutation permission and the discharge */
const DERIVED_MACAROONS = 3;
/** an organization token, once attenuated: one permission and its discharge */
const ATTENUATED_MACAROONS = 2;

/**
 * locates the flyctl configuration directory open-agent owns, so flyctl
 * never reads or writes the user's own login, WireGuard peers or agent
 * @returns absolute directory path
 */
export function flyctlConfigDirectory(): string {
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'open-agent',
    'flyctl',
  );
}

/**
 * builds the environment of one flyctl child from an allowlist: the token is
 * passed only here, never as an argument, and flyctl reads its configuration
 * only from the private directory
 * @param token token flyctl authenticates with; absent for a command that needs none
 * @returns child environment
 */
export function flyctlEnvironment(token?: string): Record<string, string> {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined &&
      (INHERITED_VARIABLES.has(entry[0]) || INHERITED_PREFIX.test(entry[0])),
  );

  return {
    ...Object.fromEntries(inherited),
    ...(token === undefined ? {} : { FLY_ACCESS_TOKEN: token }),
    FLY_CONFIG_DIR: flyctlConfigDirectory(),
    FLY_NO_UPDATE_CHECK: '1',
  };
}

/**
 * creates the private flyctl configuration directory and makes it private
 * even when it already existed
 * @returns absolute path of the private flyctl configuration
 */
export async function prepareFlyctlDirectory(): Promise<string> {
  const directory = flyctlConfigDirectory();
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(directory, PRIVATE_DIRECTORY_MODE);

  return directory;
}

/**
 * decodes a token offline with `fly tokens debug`
 * @param program absolute flyctl path
 * @param token token to decode
 * @returns the printed decoding, or undefined when flyctl refuses the token
 */
export async function decodeToken(
  program: string,
  token: string,
): Promise<string | undefined> {
  await prepareFlyctlDirectory();
  const result = await runOperation(async () =>
    execa(program, ['tokens', 'debug'], {
      env: flyctlEnvironment(token),
      extendEnv: false,
      stdin: 'ignore',
      timeout: FLYCTL_TIMEOUT_MS,
      cancelSignal: currentOperation()?.signal,
      reject: false,
    }),
  );

  return result.exitCode === 0 ? result.stdout : undefined;
}

/**
 * derives, offline, a token that can only open SSH sessions to one app: it
 * keeps full access to that app and WireGuard, reads nothing else beyond the
 * organization's read-only view, and may mutate only its own SSH certificate
 * and tunnel; Fly offers no API that mints such a token from an organization
 * token, so it is attenuated locally and never stored
 * @param token organization token
 * @param appNumber the app's internal numeric identity
 * @returns the SSH-scoped token
 */
export async function deriveSshToken(
  token: string,
  appNumber: number,
): Promise<string> {
  const scope: Caveat = {
    type: 'IfPresent',
    body: {
      ifs: [
        { type: 'Apps', body: { apps: { [String(appNumber)]: APP_ACCESS } } },
        {
          type: 'FeatureSet',
          body: { features: { builder: APP_ACCESS, wg: APP_ACCESS } },
        },
      ],
      else: OTHERWISE_READ,
    },
  };
  // one permission token may not both read and mutate, so a read-only token
  // and a mutation-only token share the organization token's discharge
  const reading = splitToken(
    await attenuate(token, [scope, { type: 'Action', body: OTHERWISE_READ }]),
  );
  const mutating = splitToken(
    await attenuate(token, [
      scope,
      { type: 'Mutations', body: { mutations: SSH_MUTATIONS } },
    ]),
  );
  const [read, discharge] = reading;
  const [mutate, sameDischarge] = mutating;
  if (
    reading.length !== ATTENUATED_MACAROONS ||
    mutating.length !== ATTENUATED_MACAROONS ||
    discharge !== sameDischarge
  ) {
    throw unexpectedToken(
      'is not one permission with its discharge, as an organization token is',
    );
  }
  const derived = `${MACAROON_SCHEME}${[read, mutate, discharge].join(TOKEN_SEPARATOR)}`;
  rememberSecret(derived);
  const locations = macaroonLocations(
    (await decodeToken(FLYCTL, derived)) ?? '',
  );
  if (
    locations?.length !== DERIVED_MACAROONS ||
    locations[0] !== PERMISSION_LOCATION ||
    locations[1] !== PERMISSION_LOCATION ||
    locations[2] === PERMISSION_LOCATION
  ) {
    throw unexpectedToken(
      'did not attenuate into two Fly permissions sharing one discharge',
    );
  }

  return derived;
}

/**
 * describes an organization token the SSH token cannot be derived from
 * @param what how the token or its attenuation differs
 * @returns an authentication fault
 */
function unexpectedToken(what: string): ProviderFault {
  return new ProviderFault({
    code: 'authentication',
    message: `The Fly organization token ${what}; use a token from \`fly tokens create org\``,
  });
}

/**
 * appends caveats to a token with `fly tokens attenuate`
 * @param token token to attenuate
 * @param caveats caveats to append
 * @returns the attenuated token
 */
async function attenuate(
  token: string,
  caveats: readonly Caveat[],
): Promise<string> {
  await prepareFlyctlDirectory();
  const result = await runOperation(async () =>
    execa(FLYCTL, ['tokens', 'attenuate'], {
      env: flyctlEnvironment(token),
      extendEnv: false,
      input: JSON.stringify(caveats),
      timeout: FLYCTL_TIMEOUT_MS,
      cancelSignal: currentOperation()?.signal,
      reject: false,
    }),
  );
  if (result.exitCode !== 0) {
    throw new ProviderFault({
      code: 'failed',
      message: `fly tokens attenuate failed (${result.exitCode ?? 'timeout'})`,
    });
  }
  rememberSecret(result.stdout.trim());

  return result.stdout.trim();
}

/**
 * splits a token into its macaroons
 * @param token token as flyctl prints it
 * @returns the macaroons in order
 */
function splitToken(token: string): string[] {
  return token
    .trim()
    .replace(MACAROON_SCHEME, '')
    .split(TOKEN_SEPARATOR)
    .filter((macaroon) => macaroon !== '');
}
