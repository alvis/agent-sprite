// guest kernel: imports nothing; it is a pure decision. The
// value sets below mirror the provider capability axes in
// src/drivers/contracts.ts; spec/guest/idle/permission.spec.ts passes catalog
// declarations through this signature so the two cannot drift apart

/** the provider capability axes and profile option the sleep decision reads */
export interface SleepPermissionParams {
  /** who decides when the workstation sleeps */
  keepAwakeMode: 'native-deadline' | 'governed' | 'none';
  /** how a sleeping workstation is woken */
  wakeMode: 'url-traffic' | 'cli-restore' | 'always-on';
  /** a cli-restore provider opts in to governor-initiated sleep */
  supportsCliWakeSleep: boolean;
  /** minutes without heartbeat or hold before sleep; 0 never initiates sleep */
  idleTimeoutMinutes: number;
}

/**
 * decides whether the idle governor may suspend or stop the workstation; it
 * never may without a wake path (URL traffic, or an opted-in CLI restore)
 * @param params provider capability axes and the configured idle timeout
 * @returns true only when governor-initiated sleep is permitted
 */
export function isSleepPermitted(params: SleepPermissionParams): boolean {
  const { keepAwakeMode, wakeMode, supportsCliWakeSleep, idleTimeoutMinutes } =
    params;

  return (
    keepAwakeMode === 'governed' &&
    idleTimeoutMinutes > 0 &&
    (wakeMode === 'url-traffic' ||
      (wakeMode === 'cli-restore' && supportsCliWakeSleep))
  );
}
