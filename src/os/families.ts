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

/**
 * finds the family an `/etc/os-release` belongs to, by `ID` or `ID_LIKE`
 * @param osRelease the parsed `/etc/os-release` fields
 * @returns the matching family, or nothing when no supported family matches
 */
export function matchFamily(
  osRelease: Readonly<Record<string, string>>,
): OsFamily | undefined {
  return Object.values(OS_FAMILIES).find((family) => family.matches(osRelease));
}
