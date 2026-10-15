import { ProviderFault } from '#drivers/failures';

import { describeGuest } from './machines.js';
import { isManagedMetadata, readMetadata } from './metadata.js';

import type { WorkstationRecord } from '#drivers/contracts';

import type { FlyMachine } from './wire.js';

/**
 * names the public URL the Fly proxy serves an app at
 * @param app name of the workstation app
 * @returns absolute https URL
 */
export function appUrl(app: string): string {
  return `https://${app}.fly.dev`;
}

/** run states of a machine that is being or has been destroyed */
const GONE_STATES = new Set(['destroying', 'destroyed']);

/**
 * projects a machine onto the provider-neutral record; the app name is the
 * workstation name and the machine identity is the immutable identity. The
 * URL is the name the Fly proxy serves the app at, assigned with the app as
 * a Sprite URL is with its Sprite; like a private Sprite URL it serves no
 * one until exposure attaches public addresses
 * @param app app name
 * @param organization organization slug owning the app
 * @param machine freshly observed machine
 * @returns the workstation record
 */
export function toRecord(
  app: string,
  organization: string,
  machine: FlyMachine,
): WorkstationRecord {
  return {
    id: machine.id,
    name: app,
    organization,
    ...(machine.createdAt ? { createdAt: machine.createdAt } : {}),
    state: machine.state,
    ...(machine.guest ? { machine: describeGuest(machine.guest) } : {}),
    url: appUrl(app),
    metadata: readMetadata(machine.metadata),
  };
}

/**
 * tells whether a machine is neither being nor has been destroyed
 * @param machine observed machine
 * @returns true for a machine that still counts
 */
export function isLive(machine: FlyMachine): boolean {
  return !GONE_STATES.has(machine.state);
}

/**
 * tells whether a machine carries the ownership key
 * @param machine observed machine
 * @returns true for an open-agent machine
 */
export function isManaged(machine: FlyMachine): boolean {
  return isManagedMetadata(machine.metadata);
}

/**
 * requires an app to hold exactly one live machine, owned by open-agent
 * @param app app name
 * @param machines every machine of the app
 * @returns the single managed machine
 */
export function workstationMachine(
  app: string,
  machines: readonly FlyMachine[],
): FlyMachine {
  const [machine, ...others] = machines.filter(isLive);
  if (!machine || others.length > 0 || !isManaged(machine)) {
    throw new ProviderFault({
      code: 'ownership-mismatch',
      message: `Fly app ${app} is not a verified open-agent workstation`,
    });
  }

  return machine;
}
