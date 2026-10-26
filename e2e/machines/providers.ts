import { registry } from '#composition/registry';

import { TEST_PREFIX } from './identity';
import { createFlyProvider } from './providers/fly';
import { createSpriteProvider } from './providers/sprite';

import type { ProviderId } from '#domain/ids';

import type { Redactor } from './redaction';

/** a machine type: the provider the CLI creates the workstation on */
export type MachineType = ProviderId;

/** identifiers a workstation carries, as observed at the provider */
export interface WorkstationIdentity {
  /** provider labels attached to the workstation */
  labels: readonly string[];
  /** the labels every managed workstation of the provider carries */
  requiredLabels: readonly string[];
  /** direct children of the guest directories that hold manager state */
  guestPaths: readonly string[];
  /** contents of the guest maintenance schedule */
  schedule: string;
}

/** what the provider reports about one supervised service process */
export interface ServiceProcess {
  /** service name */
  name: string;
  /** current status */
  status: string;
  /** services it starts after */
  needs: string[];
  /** process id while running */
  pid: number | undefined;
  /** when the current process started */
  startedAt: string | undefined;
}

/** whether a workstation runs or sleeps, as the provider itself reports it */
export interface RunState {
  /** provider status; a Sprite is `running`, `warm` or `cold` */
  status: string;
  /** the provider's last transition to running */
  lastRunningAt: string | undefined;
  /** the provider's last transition to a sleeping state, which a Sprite reports only while asleep */
  lastWarmingAt: string | undefined;
}

/** workstations one provider account holds, with direct fallback deletion */
export interface MachineInventory {
  /** machine type whose provider account the inventory reads */
  readonly name: MachineType;
  /**
   * lists every provider workstation whose name starts with the prefix
   * @param prefix exact name prefix
   * @returns matching names, managed or not
   */
  listWorkstations(prefix: string): Promise<string[]>;
  /**
   * tells whether the provider still has the exact workstation
   * @param name exact workstation name
   * @returns true while the provider reports it
   */
  hasWorkstation(name: string): Promise<boolean>;
  /**
   * deletes directly through the provider after rechecking name, scope and label
   * @param name exact workstation name
   * @param scope cleanup scope that must contain the name
   */
  deleteWorkstation(name: string, scope: string): Promise<void>;
}

/** what a provider adapter acts with */
export interface MachineProviderOptions {
  /** the machine type's management credential */
  token: string;
  /** removes credential values from guest output before any test reads it */
  redact: Redactor;
}

/** out-of-band access to the workstations of one machine type */
export interface MachineProvider extends MachineInventory {
  /**
   * reads the labels and manager-owned guest paths of a running workstation
   * @param name exact workstation name
   * @returns observed identifiers
   */
  inspectIdentity(name: string): Promise<WorkstationIdentity>;
  /**
   * runs a shell script in the guest as the provider's exec account (root)
   * @param name exact workstation name
   * @param script `sh -c` script
   * @returns the script's standard output, redacted
   * @throws {Error} with the exit code and the end of the redacted standard
   * error when the script exits non-zero
   */
  execute(name: string, script: string): Promise<string>;
  /**
   * reads every supervised service's process identity straight from the provider
   * @param name exact workstation name
   * @returns services ordered by name, so two reads compare directly
   */
  snapshotServices(name: string): Promise<ServiceProcess[]>;
  /**
   * reads whether the workstation runs or sleeps through the management API,
   * which neither wakes it nor keeps it awake
   * @param name exact workstation name
   * @returns the state, or nothing when the provider answered with a record
   * that carries no status or transition times, which the Sprites API
   * sometimes does
   */
  readRunState(name: string): Promise<RunState | undefined>;
  /**
   * reads the expiry of the provider's own awake task, which the agent
   * account reaches without a credential
   * @param name exact workstation name
   * @returns the expiry, absent when the provider holds no such task
   */
  readAwakeTask(name: string): Promise<string | undefined>;
  /**
   * reads the public URL the provider routes to the workstation
   * @param name exact workstation name
   * @returns absolute URL
   */
  readUrl(name: string): Promise<string>;
}

/**
 * the variable holding the management credential of a machine type, as its
 * catalog prerequisites declare, with the e2e prefix
 * @param type machine type
 * @returns `TEST_` and the credential's environment name
 */
export function credentialVariable(type: MachineType): string {
  return `${TEST_PREFIX}${registry.providers[type].prerequisites.credential.environment}`;
}

/**
 * creates the provider adapter of a machine type
 * @param type the provider the adapter drives
 * @param options credential and redaction
 * @returns provider adapter
 */
export function createMachineProvider(
  type: MachineType,
  options: MachineProviderOptions,
): MachineProvider {
  return type === 'sprite'
    ? createSpriteProvider(options)
    : createFlyProvider(options);
}
