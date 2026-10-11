import { isRecord } from './records.js';

/** service definition validated from the guest management CLI */
export interface ManagedService {
  name: string;
  cmd: string;
  args?: string[];
  needs?: string[];
  state?: { name: string; status: string; pid?: number } | null;
}

const serviceStatuses = new Set([
  'stopped',
  'starting',
  'running',
  'stopping',
  'failed',
]);
const serviceEventTypes = new Set([
  'stdout',
  'stderr',
  'exit',
  'error',
  'complete',
  'started',
  'stopping',
  'stopped',
]);

/** typed guest-local failure for untrusted sprite-env service responses */
class ServiceResponseFault extends Error {
  public readonly code = 'PROVIDER';
  /**
   * @param message fixed public diagnostic
   * @param [options] internal cause, when available
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * selects only registered services from one complete validated registry response
 * @param output successful service-list JSON output
 * @param selected manifest-selected managed services
 * @returns selected names present in the registry
 */
export function registeredManagedServices(
  output: string,
  selected: readonly string[],
): string[] {
  const services = parseServiceJson(output);
  if (!Array.isArray(services)) {
    throw new ServiceResponseFault(
      'Managed service registry returned a malformed result',
    );
  }
  const registered = new Set<string>();
  for (const service of services) {
    assertServiceRecord(service);
    if (!Object.hasOwn(service, 'args') || !Object.hasOwn(service, 'needs')) {
      throw new ServiceResponseFault(
        'Managed service registry returned an incomplete definition',
      );
    }
    if (registered.has(service.name)) {
      throw new ServiceResponseFault(
        'Managed service registry returned duplicate names',
      );
    }
    registered.add(service.name);
  }

  return selected.filter((name) => registered.has(name));
}

/**
 * validates one requested service without treating malformed output as absence
 * @param output successful service-get JSON output
 * @param name exact requested service identity
 * @returns validated service definition and optional live state
 */
export function parseManagedService(
  output: string,
  name: string,
): ManagedService {
  const service = parseServiceJson(output);
  if (isRecord(service) && service.needs === null) {
    service.needs = [];
  }
  assertServiceRecord(service);
  if (service.name !== name) {
    throw new ServiceResponseFault(
      'Managed service lookup returned a different identity',
    );
  }

  return service;
}

/**
 * rejects malformed or unsuccessful action events even when the CLI exits zero
 * @param output successful command's private NDJSON stream
 */
export function assertServiceAction(output: string): void {
  const lines = output.trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    throw new ServiceResponseFault('Managed service action returned no events');
  }
  for (const line of lines) {
    const event = parseServiceJson(line);
    if (
      !isRecord(event) ||
      typeof event.type !== 'string' ||
      !serviceEventTypes.has(event.type) ||
      event.type === 'error' ||
      (event.type === 'exit' && event.exit_code !== 0)
    ) {
      throw new ServiceResponseFault(
        'Managed service action returned a failed or malformed event',
      );
    }
  }
}

/**
 * checks the documented service definition and any returned runtime state
 * @param service untrusted provider-owned service record
 */
function assertServiceRecord(
  service: unknown,
): asserts service is ManagedService {
  if (
    !isRecord(service) ||
    typeof service.name !== 'string' ||
    service.name.length === 0 ||
    typeof service.cmd !== 'string' ||
    service.cmd.length === 0 ||
    (service.args !== undefined &&
      (!Array.isArray(service.args) ||
        !service.args.every((argument) => typeof argument === 'string'))) ||
    (service.needs !== undefined &&
      (!Array.isArray(service.needs) ||
        !service.needs.every(
          (name) => typeof name === 'string' && name.length > 0,
        )))
  ) {
    throw new ServiceResponseFault(
      'Managed service registry returned a malformed definition',
    );
  }
  assertServiceState(service);
}

/**
 * validates optional runtime state against its service identity
 * @param service validated service definition
 */
function assertServiceState(service: Record<string, unknown>): void {
  const state = service.state;
  if (
    state !== undefined &&
    state !== null &&
    (!isRecord(state) ||
      state.name !== service.name ||
      typeof state.status !== 'string' ||
      !serviceStatuses.has(state.status) ||
      (state.pid !== undefined &&
        (typeof state.pid !== 'number' ||
          !Number.isSafeInteger(state.pid) ||
          state.pid <= 0)))
  ) {
    throw new ServiceResponseFault(
      'Managed service registry returned a malformed state',
    );
  }
}

/**
 * parses provider JSON without putting private output into diagnostics
 * @param output one complete provider response
 * @returns parsed provider data
 */
function parseServiceJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch (cause) {
    throw new ServiceResponseFault(
      'Managed service command returned malformed JSON',
      { cause },
    );
  }
}
