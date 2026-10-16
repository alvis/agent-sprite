import { debianFamily } from './debian/family.js';

import type { OsFamily, OsFamilyId, OsRelease } from './contracts.js';

/** every OS family setup supports, by identifier */
export const OS_FAMILIES: Readonly<Record<OsFamilyId, OsFamily>> = {
  debian: debianFamily,
};

/**
 * looks up the family a probed release belongs to
 * @param release the guest's release
 * @returns the release's family
 */
export function familyOf(release: Pick<OsRelease, 'family'>): OsFamily {
  return OS_FAMILIES[release.family];
}
