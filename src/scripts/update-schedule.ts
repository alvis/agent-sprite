const weekMs = 604_800_000;

/**
 * decides whether seven days have elapsed since the last successful installation
 * @param lastSuccessfulUpdate recorded successful-update time or creation time
 * @param nowMs current epoch time in milliseconds
 * @returns whether maintenance is due, including an invalid recorded time
 */
export function isUpdateDue(
  lastSuccessfulUpdate: string,
  nowMs = Date.now(),
): boolean {
  const lastSuccessMs = Date.parse(lastSuccessfulUpdate);

  return !Number.isFinite(lastSuccessMs) || nowMs - lastSuccessMs >= weekMs;
}
