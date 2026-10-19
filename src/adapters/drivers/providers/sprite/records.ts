import { ProviderFault } from '#kernel/provider-fault';

import { MANAGED_LABEL, readMetadataLabels } from './labels';
import { SPRITE_MACHINE } from './machines';

import type { Sprite } from '@fly/sprites';

import type { WorkstationRecord } from '#domain/workstation';

/**
 * projects a live Sprite onto the provider-neutral record; a missing identity
 * stays empty so core reports it rather than this projection inventing one
 * @param sprite freshly fetched Sprite
 * @returns the workstation record
 */
export function toRecord(sprite: Sprite): WorkstationRecord {
  return {
    id: sprite.id ?? '',
    name: sprite.name,
    organization: sprite.organizationName ?? '',
    ...(sprite.createdAt ? { createdAt: sprite.createdAt.toISOString() } : {}),
    state: sprite.status ?? 'unknown',
    machine: SPRITE_MACHINE,
    ...(sprite.url ? { url: sprite.url } : {}),
    metadata: readMetadataLabels(sprite.labels),
  };
}

/**
 * tells whether a Sprite carries the ownership label
 * @param sprite observed Sprite
 * @returns true for an open-agent Sprite
 */
export function isManaged(sprite: Sprite): boolean {
  return sprite.labels.includes(MANAGED_LABEL);
}

/**
 * rejects mutation of a Sprite open-agent does not own
 * @param sprite Sprite about to be changed
 */
export function assertManaged(sprite: Sprite): void {
  if (!isManaged(sprite)) {
    throw new ProviderFault({
      code: 'ownership-mismatch',
      message: `Sprite ${sprite.name} is not managed by open-agent`,
    });
  }
}

/**
 * requires immutable identity and ownership before inspection or mutation
 * @param sprite freshly fetched Sprite
 * @param name requested name
 */
export function assertVerifiedWorkstation(sprite: Sprite, name: string): void {
  if (!sprite.id || !sprite.organizationName || !isManaged(sprite)) {
    throw new ProviderFault({
      code: 'ownership-mismatch',
      message: `Sprite ${name} is not a verified open-agent workstation`,
    });
  }
}
