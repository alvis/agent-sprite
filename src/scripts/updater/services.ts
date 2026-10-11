import { execFileSync } from 'node:child_process';

import {
  assertServiceAction,
  parseManagedService,
  registeredManagedServices,
} from '../update-services.js';

import { findTrustedExecutable, spriteEnvironment } from './executables.js';

import type { ManagedService } from '../update-services.js';

const restartPollMs = 1_000;
const restartAttempts = 30;

/**
 * restarts dependencies before their managed consumers and verifies replacement PIDs
 * @param services exact managed services selected for update
 * @param onStep records the exact managed service step
 * @returns after every selected service has restarted
 */
export async function restartManagedServices(
  services: string[],
  onStep: (step: string) => void,
): Promise<void> {
  const executable = await findTrustedExecutable('sprite-env');
  const registered = registeredManagedServices(
    execFileSync(executable, ['services', 'list'], {
      env: spriteEnvironment,
      encoding: 'utf8',
      timeout: 10_000,
    }),
    services,
  );
  const t3DependsOnTailnet =
    registered.includes('t3-code') && registered.includes('tailscaled');
  if (!t3DependsOnTailnet) {
    for (const service of registered) {
      await restartManagedService(service, onStep);
    }

    return;
  }
  onStep('managed service t3-code stop');
  const previousT3 = getManagedService('t3-code', executable);
  runServiceAction('t3-code', 'stop', executable);
  let restartFailure: Error | undefined;
  try {
    await restartManagedService('tailscaled', onStep);
  } catch (error) {
    restartFailure =
      error instanceof Error
        ? error
        : new Error('Managed service restart failed', { cause: error });
  }
  try {
    onStep('managed service t3-code start');
    runServiceAction('t3-code', 'start', executable);
    onStep('managed service t3-code restart verification');
    await waitForReplacement('t3-code', executable, previousT3.state?.pid);
  } catch (error) {
    if (restartFailure) {
      throw new AggregateError(
        [restartFailure, error],
        'Managed service restart and restoration failed',
      );
    }
    throw error;
  }
  if (restartFailure) {
    onStep('managed service tailscaled restart');
    throw restartFailure;
  }
}

/**
 * restarts one supervised service and verifies its replacement PID
 * @param name managed Sprite service name
 * @param onStep records the exact managed service step
 * @returns after the service runs with a new PID
 */
async function restartManagedService(
  name: string,
  onStep: (step: string) => void,
): Promise<void> {
  onStep(`managed service ${name} restart`);
  const spriteEnvExecutable = await findTrustedExecutable('sprite-env');
  const before = getManagedService(name, spriteEnvExecutable);
  runServiceAction(name, 'restart', spriteEnvExecutable);
  onStep(`managed service ${name} restart verification`);
  await waitForReplacement(name, spriteEnvExecutable, before.state?.pid);
}

/**
 * validates streamed service events even when the guest CLI exits zero
 * @param name exact managed service name
 * @param action supported service operation
 * @param executable trusted native guest management tool
 */
function runServiceAction(
  name: string,
  action: 'stop' | 'start' | 'restart',
  executable: string,
): void {
  const output = execFileSync(executable, ['services', action, name], {
    env: spriteEnvironment,
    encoding: 'utf8',
    timeout: 45_000,
  });
  assertServiceAction(output);
}

/**
 * waits for asynchronous registry state to confirm a new running process
 * @param name exact managed service name
 * @param executable trusted native guest management tool
 * @param previousPid process identity before restart
 * @returns after a distinct process is running
 */
async function waitForReplacement(
  name: string,
  executable: string,
  previousPid: number | undefined,
): Promise<void> {
  for (let attempt = 0; attempt < restartAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, restartPollMs));
    const after = getManagedService(name, executable);
    if (
      after.state?.status === 'running' &&
      after.state.pid &&
      after.state.pid !== previousPid
    ) {
      return;
    }
  }
  throw new Error(`managed service ${name} did not restart`);
}

/**
 * reads a service's current state through the guest-local management CLI
 * @param name managed Sprite service name
 * @param spriteEnvExecutable resolved management executable
 * @returns parsed service record
 */
function getManagedService(
  name: string,
  spriteEnvExecutable: string,
): ManagedService {
  return parseManagedService(
    execFileSync(spriteEnvExecutable, ['services', 'get', name], {
      env: spriteEnvironment,
      encoding: 'utf8',
      timeout: 10_000,
    }),
    name,
  );
}
