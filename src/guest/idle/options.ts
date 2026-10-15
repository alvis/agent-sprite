import { isRecord } from '../records.js';

// guest kernel: imports only Node built-ins and other guest code, and names no
// provider. The stored profile validates both options on the host; the guest
// reads them again field by field, so a defect in one option or elsewhere in
// the profile never hides the other valid one

/** minutes without heartbeat or hold before sleep when the stored profile names none */
const DEFAULT_IDLE_TIMEOUT_MINUTES = 5;

/** minutes a hold lasts after its last refresh when the stored profile names none */
export const DEFAULT_HOLD_MAX_MINUTES = 60;

// beyond about a century the deadline arithmetic would leave the range of a
// date; a stored value above it means "practically never" and is capped
const MAX_OPTION_MINUTES = 50_000_000;

/** the idle options the governor applies, and why a default replaced a stored value */
export interface IdleOptions {
  /** minutes without heartbeat or hold before sleep; 0 never initiates sleep */
  idleTimeoutMinutes: number;
  /** minutes a hold lasts after its last refresh */
  holdMaxMinutes: number;
  /** one entry per option the stored profile could not supply as stored */
  diagnostics: string[];
}

/**
 * reads the idle timeout and the hold maximum from the stored profile, never
 * failing an awake event; each option decides alone
 * @param profile decoded profile of the installation manifest
 * @returns the stored options, or the defaults with the reason each applies
 */
export function storedIdleOptions(profile: unknown): IdleOptions {
  const options =
    isRecord(profile) && isRecord(profile.options) ? profile.options : {};
  const diagnostics: string[] = [];
  const idleTimeoutMinutes = storedMinutes({
    name: 'idleTimeoutMinutes',
    value: options.idleTimeoutMinutes,
    minimum: 0,
    fallback: DEFAULT_IDLE_TIMEOUT_MINUTES,
    diagnostics,
  });
  const holdMaxMinutes = storedMinutes({
    name: 'holdMaxMinutes',
    value: options.holdMaxMinutes,
    minimum: 1,
    fallback: DEFAULT_HOLD_MAX_MINUTES,
    diagnostics,
  });

  return { idleTimeoutMinutes, holdMaxMinutes, diagnostics };
}

/**
 * validates one stored whole-minute option
 * @param params the option, its untrusted value, its bounds and default
 * @param params.name option name for the diagnostic
 * @param params.value untrusted stored value
 * @param params.minimum smallest valid value
 * @param params.fallback default applied when the value is unusable
 * @param params.diagnostics accumulating diagnostics
 * @returns the usable number of minutes
 */
function storedMinutes(params: {
  name: string;
  value: unknown;
  minimum: number;
  fallback: number;
  diagnostics: string[];
}): number {
  const { name, value, minimum, fallback, diagnostics } = params;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    diagnostics.push(
      `stored ${name} is missing or invalid; the default of ${fallback} minutes applies`,
    );

    return fallback;
  }
  if (value > MAX_OPTION_MINUTES) {
    diagnostics.push(
      `stored ${name} exceeds ${MAX_OPTION_MINUTES} minutes and is capped there`,
    );

    return MAX_OPTION_MINUTES;
  }

  return value;
}
