// the shape of environment.json, as checks composed field by field; a
// malformed record is reported by the first top-level field that is wrong

import { parseProfile } from '#core/profile';
import { GUEST_ROOT } from '#guest/guest-root';
import { isRecord } from '#utilities/guards';

import type { GuestEnvironment } from './environment.js';

/** tells whether a value has a shape */
type Check = (value: unknown) => boolean;

/** a service, job or tool name a guest path or cron entry can carry */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
/** an environment variable name */
const VARIABLE_PATTERN = /^[A-Z_a-z]\w*$/;
const MAX_PORT = 65_535;

/**
 * accepts one of the given strings
 * @param values the allowed strings
 * @returns the check
 */
const oneOf =
  (...values: readonly string[]): Check =>
  (value) =>
    typeof value === 'string' && values.includes(value);

/**
 * accepts an array whose every item passes
 * @param item the check of each item
 * @returns the check
 */
const listOf =
  (item: Check): Check =>
  (value) =>
    Array.isArray(value) && value.every(item);

/**
 * accepts a value that is absent or passes
 * @param check the check of a present value
 * @returns the check
 */
const optional =
  (check: Check): Check =>
  (value) =>
    value === undefined || check(value);

/**
 * accepts an object whose every listed field passes its check
 * @param fields each field's check
 * @returns the check
 */
const shape =
  (fields: Readonly<Record<string, Check>>): Check =>
  (value) =>
    isRecord(value) &&
    Object.entries(fields).every(([field, check]) => check(value[field]));

/**
 * accepts a whole number no smaller than a least
 * @param least the smallest allowed number
 * @returns the check
 */
const atLeast =
  (least: number): Check =>
  (value) =>
    Number.isSafeInteger(value) && (value as number) >= least;

// a non-empty string
const text: Check = (value) => typeof value === 'string' && value !== '';
// any string, an empty one included
const word: Check = (value) => typeof value === 'string';
// a boolean
const flag: Check = (value) => typeof value === 'boolean';
// a name a guest path or cron entry can carry
const name: Check = (value) =>
  typeof value === 'string' && NAME_PATTERN.test(value);
// an absolute guest path
const path: Check = (value) =>
  typeof value === 'string' && value.startsWith('/');
// a TCP port
const port: Check = (value) =>
  atLeast(1)(value) && (value as number) <= MAX_PORT;
// a map of environment variable names to strings
const variables: Check = (value) =>
  isRecord(value) &&
  Object.entries(value).every(
    ([variable, setting]) =>
      VARIABLE_PATTERN.test(variable) && typeof setting === 'string',
  );
/** a guest account a command or service runs as */
const account = oneOf('root', 'agent');

// a tool source of a known kind, with that kind's fields
const source: Check = (value) => {
  const fields: Readonly<Record<string, Check>> | undefined = isRecord(value)
    ? {
        brew: {
          formula: text,
          tap: optional(text),
          binDirs: optional(listOf(text)),
        },
        system: {
          family: text,
          packages: listOf(text),
          vendorServices: optional(listOf(text)),
        },
        npm: { package: text, account: oneOf('agent') },
        rustup: {
          toolchain: text,
          components: listOf(text),
          account: oneOf('agent'),
        },
      }[String(value.kind)]
    : undefined;

  return fields !== undefined && shape(fields)(value);
};

/** the program, arguments and account a service or job runs */
const run = { command: path, arguments: listOf(word), account };

/** every top-level field and its check */
const FIELDS: Readonly<Record<string, Check>> = {
  openAgent: shape({ version: text, setupAt: text }),
  setup: shape({
    state: oneOf('ready', 'incomplete'),
    skipped: listOf(shape({ name, reason: text })),
  }),
  profile: (value) => parseProfile(value).isValid,
  tools: listOf(
    shape({
      name,
      required: flag,
      account: oneOf('root', 'linuxbrew', 'agent'),
      executables: listOf(text),
      source,
    }),
  ),
  schedule: shape({ dueDays: atLeast(1) }),
  provider: shape({
    id: text,
    serviceBackend: oneOf('provider', 'runit'),
    keepAwakeMode: oneOf('native-deadline', 'governed', 'none'),
    idleForms: listOf(
      oneOf('provider-managed', 'memory-suspend', 'stop', 'disk-snapshot'),
    ),
    wakeMode: oneOf('url-traffic', 'cli-restore', 'always-on'),
    supportsCliWakeSleep: flag,
    maxAwakeDeadlineMinutes: (value) => value === null || atLeast(1)(value),
    transportNetworks: listOf(text),
    idleTimeoutMinutes: atLeast(0),
    holdMaxMinutes: atLeast(1),
  }),
  agent: shape({
    id: text,
    service: name,
    account,
    port,
    harnesses: listOf(
      shape({
        id: text,
        environment: variables,
        adapter: optional(
          shape({
            tool: name,
            launch: shape({
              program: text,
              arguments: listOf(word),
              account: optional(account),
              environment: optional(variables),
            }),
          }),
        ),
      }),
    ),
  }),
  network: (value) =>
    value === null ||
    shape({
      id: text,
      daemon: name,
      launcher: shape({
        stateDirectory: (directory) =>
          typeof directory === 'string' &&
          directory.startsWith(`${GUEST_ROOT}/`),
        socket: path,
        tun: name,
      }),
    })(value),
  services: listOf(
    shape({ name, ...run, needs: listOf(name), httpPort: optional(port) }),
  ),
  jobs: listOf(shape({ name, everyMinutes: atLeast(1), run: shape(run) })),
  networkIdentity: optional(
    shape({ network: text, deviceId: optional(word), ip: optional(word) }),
  ),
};

/**
 * finds the first malformed top-level field of a record, then the first
 * reference it cannot resolve
 * @param candidate the candidate record
 * @returns what is wrong, or nothing when the record is valid
 */
export function environmentProblem(candidate: object): string | undefined {
  const value = candidate as Record<string, unknown>;
  const malformed = Object.entries(FIELDS).find(
    ([field, check]) => !check(value[field]),
  );
  if (malformed) {
    return `${malformed[0]} is malformed`;
  }

  return consistencyProblem(value as unknown as GuestEnvironment);
}

/**
 * finds the first reference a well-formed record cannot resolve
 * @param environment a record whose every field is well formed
 * @returns what is inconsistent, or nothing
 */
function consistencyProblem(environment: GuestEnvironment): string | undefined {
  const { services, agent, network, tools } = environment;
  const names = new Set(services.map((service) => service.name));
  if (names.size !== services.length) {
    return 'a service is defined twice';
  }
  for (const service of services) {
    const missing = service.needs.find((need) => !names.has(need));
    if (missing !== undefined) {
      return `service ${service.name} needs ${missing}, which is not defined`;
    }
  }
  const agentService = services.find(
    (service) => service.name === agent.service,
  );
  if (agentService?.account !== agent.account) {
    return `the agent's service ${agent.service} is not defined, or runs as another account`;
  }
  if (network && !names.has(network.daemon)) {
    return `the network's daemon ${network.daemon} is not defined`;
  }
  const installed = new Set(tools.map((tool) => tool.name));
  const unadapted = agent.harnesses.find(
    ({ adapter }) => adapter && !installed.has(adapter.tool),
  );
  if (unadapted) {
    return `harness ${unadapted.id} launches an adapter that is not installed`;
  }

  return undefined;
}
