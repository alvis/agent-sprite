import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { CommandFault } from '#errors';
import { checkOperation, runBoundedIO } from '#operation';
import { isRecord } from '#utilities/guards';

import { readInputFile } from '#utilities/input-file';
import { runLocal, sendLocalInput } from '#utilities/process';
import { rememberSecret } from '#utilities/redaction';

/** local store entry of a management credential, as a provider or network declares it; guest credentials are separate */
export type ManagementCredentialName = string;

/** explicit persistence choice for a local management credential */
interface CredentialSaveOptions {
  consent: boolean;
  allowProtectedFileFallback: boolean;
  location?: CredentialStoreLocation;
}

/** explicit real store for an isolated caller; omitted means normal OS selection */
export type CredentialStoreLocation =
  | { backend: 'protected-file'; path: string }
  | { backend: 'keychain'; path: string; fallbackFilePath?: string };

/** Actual persistence backend and a fixed, non-secret fallback explanation. */
export interface CredentialSaveResult {
  storage: 'keychain' | 'protected-file';
  fallbackReason?:
    | 'Keychain is unavailable on this platform'
    | 'Keychain input cannot be stored safely'
    | 'Keychain write could not be verified';
}

const excessivePermissionBits = 0o077;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const securityLineLimit = 4096;

/**
 * returns an explicitly retained management secret from the OS or protected file
 * @param name management credential to retrieve
 * @param location optional explicitly selected real credential store
 * @returns retained secret, or undefined when none was stored
 */
export async function readLocalCredential(
  name: ManagementCredentialName,
  location?: CredentialStoreLocation,
): Promise<string | undefined> {
  const keychainPath =
    location?.backend === 'keychain'
      ? absoluteStorePath(location.path)
      : undefined;
  if (platform() === 'darwin' && location?.backend !== 'protected-file') {
    try {
      const value = await runLocal({
        program: '/usr/bin/security',
        arguments: [
          'find-generic-password',
          '-s',
          'open-agent',
          '-a',
          name,
          '-w',
          ...(keychainPath ? [keychainPath] : []),
        ],
        trimOutput: false,
      });
      const credential = value.replace(/\r?\n$/u, '');
      rememberSecret(credential);

      return credential;
    } catch {
      checkOperation();
      /* missing item or unavailable Keychain falls through */
    }
  }
  const path = getCredentialPath(location);
  if (!path) {
    return undefined;
  }
  try {
    const info = await runBoundedIO(async () => stat(path));
    if ((info.mode & excessivePermissionBits) !== 0) {
      throw new CommandFault({
        code: 'INPUT',
        message: 'Local credential file permissions are too broad',
      });
    }
    const credentials = parseCredentialRecord(await readInputFile(path));

    const value =
      typeof credentials[name] === 'string' ? credentials[name] : undefined;
    rememberSecret(value);

    return value;
  } catch (error) {
    checkOperation();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * retains a local secret only after explicit user consent
 * @param name management credential to retain
 * @param value secret value to store
 * @param options explicit retention and fallback choices
 * @returns the storage backend used
 */
export async function saveLocalCredential(
  name: ManagementCredentialName,
  value: string,
  options: CredentialSaveOptions,
): Promise<CredentialSaveResult> {
  rememberSecret(value);
  if (!options.consent) {
    throw new CommandFault({
      code: 'INPUT',
      message: 'Local credential retention requires explicit consent',
    });
  }
  const location = options.location;
  const keychainPath =
    location?.backend === 'keychain'
      ? absoluteStorePath(location.path)
      : undefined;
  let fallbackReason: CredentialSaveResult['fallbackReason'];
  if (platform() === 'darwin' && location?.backend !== 'protected-file') {
    try {
      if (await writeAndVerifyKeychain(name, value, keychainPath)) {
        return { storage: 'keychain' };
      }
      fallbackReason = 'Keychain write could not be verified';
    } catch (error) {
      checkOperation();
      fallbackReason =
        error instanceof CommandFault && error.code === 'INPUT'
          ? 'Keychain input cannot be stored safely'
          : 'Keychain write could not be verified';
    }
  } else if (location?.backend !== 'protected-file') {
    fallbackReason = 'Keychain is unavailable on this platform';
  }
  if (!options.allowProtectedFileFallback) {
    throw new CommandFault({
      code: 'PREFLIGHT',
      message: `${fallbackReason ?? 'OS credential storage failed'}; protected-file fallback was not approved`,
    });
  }

  const path = getCredentialPath(location);
  if (!path) {
    throw new CommandFault({
      code: 'INPUT',
      message: 'No protected credential file was selected for fallback',
    });
  }

  await saveProtectedCredential(name, value, path);

  return { storage: 'protected-file', fallbackReason };
}

/**
 * Saves through security interactive mode and verifies the exact selected item.
 * @param name management account
 * @param value registered secret
 * @param keychainPath optional explicit isolated store
 * @returns whether readback exactly matched the saved value
 */
async function writeAndVerifyKeychain(
  name: ManagementCredentialName,
  value: string,
  keychainPath?: string,
): Promise<boolean> {
  await sendLocalInput({
    program: '/usr/bin/security',
    arguments: ['-i'],
    input: securityAddCommand(name, value, keychainPath),
    verifyResultExternally: true,
  });
  const readback = await runLocal({
    program: '/usr/bin/security',
    arguments: [
      'find-generic-password',
      '-s',
      'open-agent',
      '-a',
      name,
      '-w',
      ...(keychainPath ? [keychainPath] : []),
    ],
    trimOutput: false,
  });

  return readback.replace(/\r?\n$/u, '') === value;
}

/**
 * Quotes one bounded security interactive command; no secret enters process argv.
 * @param name management account
 * @param value registered secret
 * @param keychainPath optional explicit isolated store
 * @returns one bounded input line
 */
function securityAddCommand(
  name: ManagementCredentialName,
  value: string,
  keychainPath?: string,
): string {
  const quote = (part: string): string => {
    if (/\p{Cc}/u.test(part)) {
      throw new CommandFault({
        code: 'INPUT',
        message: 'Keychain input contains unsupported control characters',
      });
    }

    return `"${part.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
  };
  const selectedStore = keychainPath ? ` ${quote(keychainPath)}` : '';
  const command = `add-generic-password -U -s ${quote('open-agent')} -a ${quote(name)} -w ${quote(value)}${selectedStore}\n`;
  if (Buffer.byteLength(command) > securityLineLimit) {
    throw new CommandFault({
      code: 'INPUT',
      message: 'Keychain input exceeds the supported command length',
    });
  }

  return command;
}

/**
 * locates the protected credential file in the user's config directory
 * @param location optional explicitly selected real credential store
 * @returns absolute credential file path when a fallback is selected
 */
function getCredentialPath(
  location?: CredentialStoreLocation,
): string | undefined {
  if (location?.backend === 'protected-file') {
    return absoluteStorePath(location.path);
  }
  if (location?.backend === 'keychain') {
    return location.fallbackFilePath
      ? absoluteStorePath(location.fallbackFilePath)
      : undefined;
  }

  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'open-agent',
    'credentials.json',
  );
}

/**
 * refuses relative explicit paths before any credential-store operation
 * @param path caller-selected store path
 * @returns validated absolute path
 */
function absoluteStorePath(path: string): string {
  if (!isAbsolute(path)) {
    throw new CommandFault({
      code: 'INPUT',
      message: 'Credential store path must be absolute',
    });
  }

  return path;
}

/**
 * parses only selected protected-file content into the expected shape
 * @param text file content
 * @returns validated non-array object suitable for credential lookup
 */
function parseCredentialRecord(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) {
      return value;
    }
  } catch {
    /* report a fixed safe input fault below */
  }
  throw new CommandFault({
    code: 'INPUT',
    message: 'Local credential file is malformed',
  });
}

/**
 * writes a consented fallback credential with private filesystem permissions
 * @param name selected management credential
 * @param value private credential content
 * @param path absolute protected credential file path
 * @returns selected persistence backend
 */
async function saveProtectedCredential(
  name: ManagementCredentialName,
  value: string,
  path: string,
): Promise<'protected-file'> {
  await runBoundedIO(async () =>
    mkdir(dirname(path), { recursive: true, mode: privateDirectoryMode }),
  );
  await runBoundedIO(async () => chmod(dirname(path), privateDirectoryMode));
  const currentText = await readInputFile(path).catch(
    (error: NodeJS.ErrnoException) => {
      checkOperation();
      if (error.code === 'ENOENT') {
        return '{}';
      }
      throw error;
    },
  );
  const current = parseCredentialRecord(currentText);
  const temporaryPath = `${path}.${randomUUID()}`;
  await runBoundedIO(async () =>
    writeFile(
      temporaryPath,
      `${JSON.stringify({ ...current, [name]: value })}\n`,
      {
        mode: privateFileMode,
        flag: 'wx',
      },
    ),
  );
  await runBoundedIO(async () => rename(temporaryPath, path));
  await runBoundedIO(async () => chmod(path, privateFileMode));

  return 'protected-file';
}
