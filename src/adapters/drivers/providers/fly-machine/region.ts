/** environment variable selecting the region of new workstations */
const REGION_VARIABLE = 'OPEN_AGENT_FLY_REGION';

/**
 * reads the region new workstations are placed in from the environment
 * @returns region code, or nothing to place them in the nearest region
 */
export function configuredRegion(): string | undefined {
  const region = process.env[REGION_VARIABLE]?.trim();

  return region === '' ? undefined : region;
}
