import { posix } from 'node:path';

import { ExecError } from '@fly/sprites';

import { CommandFault, ensureError, retainRecoveryFailure } from '#errors';
import {
  checkOperation,
  runOperation,
  runBoundedIO,
  currentOperation,
  recoverOperation,
} from '#operation';

import {
  drainServiceStartup,
  sanitizeGuestDiagnostic,
  waitForGuestService,
} from './guest/diagnostics.js';
import { openServiceStream } from './guest/stream.js';
import {
  currentGuestTransaction,
  guestServiceRequest,
} from './guest/transaction.js';

import type {
  Sprite,
  ServiceRequest,
  ServiceWithState,
  ExecResult,
} from '@fly/sprites';

import type {
  GuestRunOptions,
  GuestRunResult,
  GuestCommandResult,
} from './guest/types.js';

export type {
  GuestRunOptions,
  GuestRunResult,
  GuestCommandResult,
  GuestFileParams,
} from './guest/types.js';

const defaultGuestTimeoutMs = 120_000;
const kibibyteBytes = 1024;
const defaultGuestMaxBufferBytes = kibibyteBytes * kibibyteBytes;
const guestDiagnosticLimit = 512;
const guestStepLimit = 80;

/**
 * executes an argument array without invoking a shell or leaking output on failure
 * @param sprite target Sprite
 * @param argv executable and argument array
 * @param options command input, environment, timeout, and safe step label
 * @returns captured output from a successful command
 */
export async function runGuest(
  sprite: Sprite,
  argv: readonly string[],
  options: GuestRunOptions = {},
): Promise<GuestRunResult> {
  const result = await runGuestResult(sprite, argv, options);
  if (result.exitCode !== 0) {
    const step = sanitizeGuestDiagnostic(
      options.step ?? posix.basename(argv[0] ?? 'unknown'),
    ).slice(0, guestStepLimit);
    const tail = sanitizeGuestDiagnostic(result.stderr).slice(
      -guestDiagnosticLimit,
    );
    const tailSuffix = tail ? `: ${tail}` : '';
    throw new CommandFault({
      code: 'PROVIDER',
      message: `Guest ${step} exited with status ${result.exitCode}${tailSuffix}`,
    });
  }

  return { stdout: result.stdout, stderr: result.stderr };
}

/**
 * returns a bounded guest command's exit status without exposing output in errors
 * @param sprite target Sprite
 * @param argv executable and argument array
 * @param options command input, environment, and timeout
 * @returns captured output and exit status
 */
export async function runGuestResult(
  sprite: Sprite,
  argv: readonly string[],
  options: GuestRunOptions = {},
): Promise<GuestCommandResult> {
  const transaction = currentGuestTransaction(sprite);
  if (transaction) {
    return transaction.run(argv, options);
  }
  const [file, ...args] = argv;
  if (!file) {
    throw new Error('Guest command must contain an executable');
  }
  const execute =
    options.input === undefined
      ? sprite.execFile.bind(sprite)
      : sprite.execFileHTTP.bind(sprite);
  let result: ExecResult;
  try {
    result = await runOperation(async () =>
      execute('/usr/bin/sudo', ['-n', '-E', '--', file, ...args], {
        env: options.env,
        signal: currentOperation()?.signal,
        input: options.input,
        timeout: options.timeoutMs ?? defaultGuestTimeoutMs,
        maxBuffer: defaultGuestMaxBufferBytes,
      }),
    );
  } catch (error) {
    checkOperation();
    if (!(error instanceof ExecError)) {
      throw error;
    }
    result = error.result;
  }

  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
    exitCode: result.exitCode,
  };
}

/**
 * installs or updates a supervised Sprite service
 * @param sprite target Sprite
 * @param name identifier registered with Sprite supervision
 * @param config supervised service configuration
 */
export async function ensureGuestService(
  sprite: Sprite,
  name: string,
  config: ServiceRequest,
): Promise<void> {
  const request = {
    ...config,
    cmd: '/usr/bin/sudo',
    args: ['-n', '-E', '--', config.cmd, ...(config.args ?? [])],
    needs: config.needs ?? [],
  };
  const services = await runBoundedIO(async () =>
    guestServiceRequest(sprite, async () => sprite.listServices()),
  );
  const existing = services.find((service) => service.name === name);
  const replacing = existing && !sameServiceDefinition(existing, request);
  const dependents = replacing
    ? services.filter((service) => service.needs.includes(name))
    : [];
  if (dependents.some((dependent) => dependent.name !== 't3-code')) {
    throw new CommandFault({
      code: 'CONFLICT',
      message: `Cannot replace ${name} while an unmanaged service depends on it`,
    });
  }
  let failure: Error | undefined;
  try {
    for (const dependent of dependents) {
      await removeGuestService(sprite, dependent);
    }
    if (replacing) {
      await removeGuestService(sprite, existing);
    }
    const stream = await openServiceStream(async () =>
      guestServiceRequest(sprite, async () =>
        sprite.createService(name, request, '5s'),
      ),
    );
    await drainServiceStartup(name, stream);
    await waitForGuestService(sprite, name);
  } catch (error) {
    failure = ensureError(error);
  }
  failure = await recoverDependentServices(sprite, dependents, failure);
  if (failure) {
    throw failure;
  }
}

/**
 * compares the requested definition with the current provider-owned service
 * @param existing current service definition
 * @param requested desired supervised service definition
 * @returns whether the provider already has the requested configuration
 */
function sameServiceDefinition(
  existing: ServiceWithState,
  requested: ServiceRequest,
): boolean {
  return (
    existing.cmd === requested.cmd &&
    JSON.stringify(existing.args) === JSON.stringify(requested.args ?? []) &&
    JSON.stringify(existing.needs) === JSON.stringify(requested.needs ?? []) &&
    existing.httpPort === requested.httpPort
  );
}

/**
 * restarts a supervised Sprite service and consumes private startup output
 * @param sprite target Sprite
 * @param name identifier of the supervised process to restart
 */
export async function restartGuestService(
  sprite: Sprite,
  name: string,
): Promise<void> {
  const stream = await openServiceStream(async () =>
    guestServiceRequest(sprite, async () => sprite.restartService(name, '5s')),
  );
  await drainServiceStartup(name, stream);
  await waitForGuestService(sprite, name);
}

/**
 * reads current supervised service state
 * @param sprite target Sprite
 * @returns current supervised services
 */
export async function listGuestServices(
  sprite: Sprite,
): Promise<ServiceWithState[]> {
  return runBoundedIO(async () =>
    guestServiceRequest(sprite, async () => sprite.listServices()),
  );
}

/**
 * acquires and releases a finite guest-local task hold around actual work
 * @param sprite target Sprite
 * @param name operation identity for the hold
 * @param operation asynchronous guest work to protect
 * @returns result of the protected operation
 */
export async function withGuestTaskHold<T>(
  sprite: Sprite,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  await runGuest(
    sprite,
    [
      '/usr/local/bin/node',
      '/opt/agent-sprite/guest-task-hold.js',
      'acquire',
      encodeURIComponent(name),
    ],
    { step: 'guest task hold acquire' },
  );
  let value: T | undefined;
  let failure: Error | undefined;
  try {
    value = await operation();
  } catch (error) {
    failure = ensureError(error);
  }
  try {
    await recoverOperation(async () =>
      runGuest(
        sprite,
        [
          '/usr/local/bin/node',
          '/opt/agent-sprite/guest-task-hold.js',
          'release',
          encodeURIComponent(name),
        ],
        { step: 'guest task hold release' },
      ),
    );
  } catch (error) {
    failure = failure
      ? retainRecoveryFailure(failure, 'guest task hold release', error)
      : ensureError(error);
  }
  if (failure) {
    throw failure;
  }

  return value as T;
}

/**
 * attempts every dependent in an independently bounded recovery scope
 * @param sprite target guest
 * @param dependents services present before replacement
 * @param primary original failure, if any
 * @returns first failure with all secondary restoration details
 */
async function recoverDependentServices(
  sprite: Sprite,
  dependents: ServiceWithState[],
  primary?: Error,
): Promise<Error | undefined> {
  let failure = primary;
  for (const dependent of dependents) {
    try {
      await recoverOperation(async () =>
        restoreDependentService(sprite, dependent),
      );
    } catch (error) {
      failure = failure
        ? retainRecoveryFailure(
            failure,
            `${dependent.name} service restoration`,
            error,
          )
        : ensureError(error);
    }
  }

  return failure;
}

/**
 * restores one recorded dependent
 * @param sprite target guest
 * @param dependent service present before replacement
 */
async function restoreDependentService(
  sprite: Sprite,
  dependent: ServiceWithState,
): Promise<void> {
  await drainServiceStartup(
    dependent.name,
    await openServiceStream(async () =>
      guestServiceRequest(sprite, async () =>
        sprite.createService(dependent.name, dependent, '5s'),
      ),
    ),
  );
  await waitForGuestService(sprite, dependent.name);
}

export {
  writeGuestFile,
  assertRootFilePath,
  readGuestFile,
  guestFileExists,
  chownGuestFile,
  removeGuestFile,
} from './guest/files.js';

/**
 * stops and removes one existing definition before replacement
 * @param sprite exact target guest
 * @param service current provider-owned definition
 */
async function removeGuestService(
  sprite: Sprite,
  service: ServiceWithState,
): Promise<void> {
  if (service.state?.status === 'running') {
    await drainServiceStartup(
      service.name,
      await openServiceStream(async () =>
        guestServiceRequest(sprite, async () =>
          sprite.stopService(service.name, '5s'),
        ),
      ),
    );
  }
  await runBoundedIO(async () =>
    guestServiceRequest(sprite, async () => sprite.deleteService(service.name)),
  );
}
