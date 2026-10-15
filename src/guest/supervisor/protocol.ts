import { GUEST_KERNEL, GUEST_NODE, GUEST_ROOT } from '../guest-root.js';
import { isRecord, isStringArray } from '../records.js';

// guest kernel: constants, types and pure validators only, with no I/O, so the
// host imports them to drive the supervisor and to read its answers; names no
// provider. A provider whose services mode is `supervised` runs the guest
// supervisor as its init's child, and the host reaches it only through the
// root-run control entry, which talks to the supervisor's root-only socket

/** the entry the provider's init runs once it exists: root's file, which starts the supervisor with the managed Node */
export const SUPERVISOR_COMMAND = `${GUEST_ROOT}/bin/open-agent-supervisor`;

/** the supervisor's main module, which only root reads */
export const SUPERVISOR_MAIN = `${GUEST_KERNEL}/supervisor/main.js`;

/** the control entry the host runs as root, one request per run */
export const SUPERVISOR_CONTROL = `${GUEST_KERNEL}/supervisor/control.js`;

/** the managed Node the entry and the control entry run */
export const SUPERVISOR_NODE = GUEST_NODE;

/** the guest log the supervisor and its entry append to, beside the other guest logs */
export const SUPERVISOR_LOG = `${GUEST_ROOT}/supervisor.log`;

/**
 * the supervisor's state on the persistent guest root: the desired services
 * and their output logs, readable by root alone
 */
export const SUPERVISOR_STATE_DIRECTORY = `${GUEST_ROOT}/supervisor`;

/**
 * this boot's runtime state, on the root filesystem so a cold boot starts
 * without it: the control socket and the record of running children
 */
export const SUPERVISOR_RUN_DIRECTORY = '/run/open-agent-supervisor';

/** the control socket's name in the run directory */
export const CONTROL_SOCKET_NAME = 'control.sock';

/**
 * the maintenance timer the supervisor runs in place of cron: it starts the
 * update entry and ticks the idle governor. It is listed beside the services
 * it supervises and cannot be ensured, stopped or removed
 */
export const MAINTENANCE_TIMER = 'open-agent-timer';

/** the longest request or answer line either side reads */
export const CONTROL_LINE_LIMIT_BYTES = 65_536;

/** a service name: lowercase, starting with a letter, as every driver names its service */
export const SERVICE_NAME = /^[a-z][a-z0-9-]{0,62}$/;

/** the most arguments one service may declare */
const ARGUMENT_LIMIT = 64;
/** the longest single argument or command path */
const TEXT_LIMIT = 4_096;
/** the most services one service may need */
const NEEDS_LIMIT = 16;
const PORT_MAX = 65_535;
const DEFINITION_KEYS = new Set([
  'name',
  'command',
  'arguments',
  'account',
  'needs',
  'httpPort',
]);
const STATUSES = new Set([
  'stopped',
  'starting',
  'running',
  'stopping',
  'failed',
]);
const FAILURE_CODES = new Set([
  'invalid',
  'conflict',
  'not-found',
  'unavailable',
  'failed',
]);

/** the account a supervised service runs as */
export type ServiceAccount = 'root' | 'agent';

/**
 * one service the supervisor runs; the same shape as the drivers' service
 * definition, which the host passes unchanged
 */
export interface SupervisedService {
  /** service identifier */
  name: string;
  /** absolute program path */
  command: string;
  /** program arguments */
  arguments: string[];
  /** account the service runs as */
  account: ServiceAccount;
  /** services that must be running before this one starts */
  needs: string[];
  /** port the service listens on, which the provider publishes */
  httpPort?: number;
}

/** a service's observed state, as the host's service contract reports it */
export interface SupervisedServiceState {
  /** service identifier */
  name: string;
  /** current process state */
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
  /** services it needs */
  needs: string[];
  /** ISO 8601 instant its current process started */
  startedAt?: string;
}

/** one request to the supervisor */
export type ControlRequest =
  | {
      /** reads every service's state */
      action: 'list';
    }
  | {
      /** registers a definition and runs it, replacing a different one */
      action: 'ensure';
      /** the desired service */
      definition: SupervisedService;
    }
  | {
      /** stops a service and keeps it stopped */
      action: 'stop' | 'remove';
      /** service identifier */
      name: string;
    };

/** why a request failed */
export type ControlFailureCode =
  'invalid' | 'conflict' | 'not-found' | 'unavailable' | 'failed';

/** the supervisor's one answer to a request */
export type ControlResponse =
  | {
      /** the request was carried out */
      ok: true;
      /** every service's state, for a list */
      services?: SupervisedServiceState[];
      /** whether the service's process ended, for a stop */
      stopped?: boolean;
    }
  | {
      /** the request was refused or failed */
      ok: false;
      /** why */
      code: ControlFailureCode;
      /** non-secret reason */
      error: string;
    };

/**
 * validates a service definition, refusing any field the supervisor does not
 * know so two equal definitions always compare equal
 * @param value untrusted decoded definition
 * @returns whether the value is a definition the supervisor can run
 */
export function isSupervisedService(
  value: unknown,
): value is SupervisedService {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => DEFINITION_KEYS.has(key)) &&
    isServiceName(value.name) &&
    value.name !== MAINTENANCE_TIMER &&
    isAbsoluteProgram(value.command) &&
    isStringArray(value.arguments) &&
    value.arguments.length <= ARGUMENT_LIMIT &&
    value.arguments.every(isBoundedText) &&
    (value.account === 'root' || value.account === 'agent') &&
    isStringArray(value.needs) &&
    value.needs.length <= NEEDS_LIMIT &&
    value.needs.every(isServiceName) &&
    new Set(value.needs).size === value.needs.length &&
    !value.needs.includes(value.name) &&
    (value.httpPort === undefined ||
      (typeof value.httpPort === 'number' &&
        Number.isSafeInteger(value.httpPort) &&
        value.httpPort > 0 &&
        value.httpPort <= PORT_MAX))
  );
}

/**
 * validates one request the control entry sent
 * @param value untrusted decoded request
 * @returns whether the value is a request the supervisor serves
 */
export function isControlRequest(value: unknown): value is ControlRequest {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.action) {
    case 'list':
      return Object.keys(value).length === 1;
    case 'ensure':
      return (
        Object.keys(value).length === 2 && isSupervisedService(value.definition)
      );
    case 'stop':
    case 'remove':
      return Object.keys(value).length === 2 && isServiceName(value.name);
    default:
      return false;
  }
}

/**
 * validates the supervisor's answer as the host reads it
 * @param value untrusted decoded answer
 * @returns whether the value is a well-formed answer
 */
export function isControlResponse(value: unknown): value is ControlResponse {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === false) {
    return (
      typeof value.code === 'string' &&
      FAILURE_CODES.has(value.code) &&
      typeof value.error === 'string'
    );
  }

  return (
    value.ok === true &&
    (value.services === undefined ||
      (Array.isArray(value.services) &&
        value.services.every(isSupervisedServiceState))) &&
    (value.stopped === undefined || typeof value.stopped === 'boolean')
  );
}

/**
 * validates one listed service state
 * @param value untrusted decoded state
 * @returns whether the value is a well-formed state
 */
export function isSupervisedServiceState(
  value: unknown,
): value is SupervisedServiceState {
  return (
    isRecord(value) &&
    isServiceName(value.name) &&
    typeof value.status === 'string' &&
    STATUSES.has(value.status) &&
    isStringArray(value.needs) &&
    value.needs.every(isServiceName) &&
    (value.startedAt === undefined ||
      (typeof value.startedAt === 'string' &&
        !Number.isNaN(Date.parse(value.startedAt))))
  );
}

/**
 * compares two definitions field by field, needs in order, as the provider
 * compares a re-registered service
 * @param left one definition
 * @param right the other definition
 * @returns whether running either would run the same service
 */
export function isSameService(
  left: SupervisedService,
  right: SupervisedService,
): boolean {
  return (
    left.name === right.name &&
    left.command === right.command &&
    left.account === right.account &&
    left.httpPort === right.httpPort &&
    left.arguments.length === right.arguments.length &&
    left.arguments.every(
      (argument, index) => argument === right.arguments[index],
    ) &&
    left.needs.length === right.needs.length &&
    left.needs.every((need, index) => need === right.needs[index])
  );
}

/**
 * tells whether a value is a service name
 * @param value untrusted value
 * @returns whether the value matches the service name pattern
 */
function isServiceName(value: unknown): value is string {
  return typeof value === 'string' && SERVICE_NAME.test(value);
}

/**
 * tells whether a value is a normalised absolute program path
 * @param value untrusted value
 * @returns whether the value names a program by its absolute path
 */
function isAbsoluteProgram(value: unknown): value is string {
  return (
    isBoundedText(value) &&
    value.startsWith('/') &&
    value !== '/' &&
    !value.endsWith('/') &&
    value
      .split('/')
      .slice(1)
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

/**
 * tells whether a value is text a process argument can carry
 * @param value untrusted value
 * @returns whether the value is a string without a NUL within the length bound
 */
function isBoundedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= TEXT_LIMIT &&
    !value.includes('\0')
  );
}
