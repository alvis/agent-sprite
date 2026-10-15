import { readFile } from 'node:fs/promises';
import { isIPv4, isIPv6 } from 'node:net';

import { GUEST_ROOT } from './guest-root.js';
import { isKeepAwakeMode, isOwnAwakeModule } from './idle/provider-facts.js';
import { isRecord, isStringArray } from './records.js';

import type {
  AgentComponent,
  ComponentCatalog,
  ComponentEntry,
  NetworkComponent,
  ProviderComponent,
} from '../drivers/component-types.js';

const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const DIST_TAG = /^[a-z][a-z0-9._-]*$/;
const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]*$/;
const IPV4_PREFIX_LIMIT = 32;
const IPV6_PREFIX_LIMIT = 128;
// a network installer is an `-install` module in the guest folder of the
// network's own driver, named by its path under the guest root; a launcher or
// probe of the same driver must never be importable as an installer
const INSTALLER_MODULE =
  /^drivers\/networks\/([a-z0-9-]+)\/guest\/[a-z0-9-]+-install\.js$/;
// every value of the axis, keyed so a value added to the axis fails typecheck
// here until the reader accepts it
const WAKE_MODES: Readonly<Record<ProviderComponent['wakeMode'], true>> = {
  'url-traffic': true,
  'cli-restore': true,
  'always-on': true,
};

// the host writes this file from the selected provider, agent and network
// before any guest script that needs it runs; guest code cannot import the
// host catalog
const CATALOG_PATH = `${GUEST_ROOT}/components.json`;

/**
 * reads the provider accounts, agent and selected network the host recorded on the guest
 * @returns the validated component catalog
 * @throws {Error} naming the repair when the host has not written the catalog yet
 */
export async function readComponentCatalog(): Promise<ComponentCatalog> {
  const decoded = await readCatalogFile();
  if (!isCatalog(decoded)) {
    throw new Error('Managed component catalog is malformed');
  }

  return decoded;
}

/**
 * reads only the provider login accounts whose homes the guest manages
 * @returns the validated account names
 * @throws {Error} naming the repair when the host has not written the catalog yet
 */
export async function readShellAccounts(): Promise<string[]> {
  const decoded = await readCatalogFile();
  if (!isRecord(decoded) || !isShellAccounts(decoded.shellAccounts)) {
    throw new Error('Managed component catalog is malformed');
  }

  return decoded.shellAccounts;
}

/**
 * reads only the provider's transport networks, which a network tunnel must never route
 * @returns the validated CIDR prefixes; empty before the host records a provider
 * @throws {Error} naming the repair when the host has not written the catalog yet
 */
export async function readTransportNetworks(): Promise<string[]> {
  const decoded = await readCatalogFile();
  if (!isRecord(decoded)) {
    throw new Error('Managed component catalog is malformed');
  }
  if (decoded.provider === undefined) {
    return [];
  }
  if (!isProviderComponent(decoded.provider)) {
    throw new Error('Managed component catalog is malformed');
  }

  return decoded.provider.transportNetworks;
}

/**
 * reads and decodes the recorded catalog without validating it
 * @returns the decoded catalog
 * @throws {Error} naming the repair when the host has not written the catalog yet
 */
async function readCatalogFile(): Promise<unknown> {
  const contents = await readFile(CATALOG_PATH, 'utf8').catch(
    (error: unknown) => {
      if (isRecord(error) && error.code === 'ENOENT') {
        throw new Error(
          `Managed component catalog ${CATALOG_PATH} is missing; run \`open-agent setup <name> --section agent\` to rewrite it`,
        );
      }
      throw error;
    },
  );

  return JSON.parse(contents);
}

/**
 * validates the recorded provider login accounts
 * @param value untrusted decoded accounts
 * @returns whether every entry is a plain account name
 */
function isShellAccounts(value: unknown): value is string[] {
  return (
    isStringArray(value) && value.every((account) => ACCOUNT_NAME.test(account))
  );
}

/**
 * validates the whole recorded catalog at its guest trust boundary
 * @param value untrusted decoded catalog
 * @returns whether every entry has its required fields
 */
function isCatalog(value: unknown): value is ComponentCatalog {
  return (
    isRecord(value) &&
    isShellAccounts(value.shellAccounts) &&
    (value.provider === undefined || isProviderComponent(value.provider)) &&
    isAgent(value.agent) &&
    isComponentEntry(value.runtime) &&
    isStringArray(value.packages) &&
    value.packages.every((name) => PACKAGE_NAME.test(name)) &&
    Array.isArray(value.networks) &&
    value.networks.every(isNetwork)
  );
}

/**
 * validates the recorded provider, whose awake adapter must be an `-awake`
 * module in the provider's own guest folder
 * @param value untrusted decoded entry
 * @returns whether the entry has every required field
 */
export function isProviderComponent(
  value: unknown,
): value is ProviderComponent {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isKeepAwakeMode(value.keepAwakeMode) &&
    typeof value.wakeMode === 'string' &&
    Object.hasOwn(WAKE_MODES, value.wakeMode) &&
    typeof value.supportsCliWakeSleep === 'boolean' &&
    (value.maxAwakeDeadlineMinutes === null ||
      (typeof value.maxAwakeDeadlineMinutes === 'number' &&
        Number.isSafeInteger(value.maxAwakeDeadlineMinutes) &&
        value.maxAwakeDeadlineMinutes > 0)) &&
    (value.serviceBackend === 'provider' || value.serviceBackend === 'runit') &&
    isStringArray(value.transportNetworks) &&
    value.transportNetworks.every(isTransportNetwork) &&
    (value.awakeAdapter === undefined ||
      (typeof value.awakeAdapter === 'string' &&
        isOwnAwakeModule(value.awakeAdapter, value.id)))
  );
}

/**
 * validates one transport network as a canonical address and prefix length, so
 * it can never read as an option of the routing tool it is passed to
 * @param value untrusted decoded network
 * @returns whether the value is an IPv4 or IPv6 CIDR prefix
 */
function isTransportNetwork(value: string): boolean {
  const [address = '', length = '', ...rest] = value.split('/');
  const limit = isIPv4(address) ? IPV4_PREFIX_LIMIT : IPV6_PREFIX_LIMIT;

  return (
    (isIPv4(address) || isIPv6(address)) &&
    rest.length === 0 &&
    /^\d{1,3}$/.test(length) &&
    Number(length) <= limit
  );
}

/**
 * validates one npm-installed component
 * @param value untrusted decoded entry
 * @returns whether the entry has every required field
 */
export function isComponentEntry(value: unknown): value is ComponentEntry {
  return (
    isRecord(value) &&
    typeof value.component === 'string' &&
    typeof value.package === 'string' &&
    PACKAGE_NAME.test(value.package) &&
    isStringArray(value.probe) &&
    value.probe.length > 0 &&
    (value.distTag === undefined ||
      (typeof value.distTag === 'string' && DIST_TAG.test(value.distTag)))
  );
}

/**
 * validates the recorded agent
 * @param value untrusted decoded entry
 * @returns whether the entry has every required field
 */
function isAgent(value: unknown): value is AgentComponent {
  return (
    isComponentEntry(value) &&
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.release === undefined ||
      (typeof value.release === 'string' && DIST_TAG.test(value.release))) &&
    typeof value.httpPort === 'number' &&
    isRecord(value.harnessNames) &&
    Object.values(value.harnessNames).every((name) => typeof name === 'string')
  );
}

/**
 * validates the recorded selected network
 * @param value untrusted decoded entry
 * @returns whether the entry has every required field
 */
function isNetwork(value: unknown): value is NetworkComponent {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.component === 'string' &&
    typeof value.feed === 'string' &&
    typeof value.installer === 'string' &&
    INSTALLER_MODULE.exec(value.installer)?.[1] === value.id &&
    isStringArray(value.probe) &&
    value.probe.length > 0
  );
}
