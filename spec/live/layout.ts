import { AWAKE_COMMAND } from '#integrations/guest/awake';
import {
  HOMEBREW_PREFIX,
  LINUXBREW_HOME,
  SESSION_DIRECTORY,
} from '#integrations/guest/layout';
import { isRecord } from '#utilities/guards';

// where a live check finds what setup left on the guest

/** the Homebrew account, its home, prefix and command */
export const HOMEBREW = {
  account: 'linuxbrew',
  home: LINUXBREW_HOME,
  prefix: HOMEBREW_PREFIX,
  brew: `${HOMEBREW_PREFIX}/bin/brew`,
} as const;

/** the agent's awake directory, relative to the guest root */
export const AWAKE_DIRECTORY = 'run/awake';

/** root's awake directory, relative to the guest root */
export const MANAGED_AWAKE_DIRECTORY = 'run/awake-root';

/**
 * root's command that prints the newer of the governor states root and the
 * agent each record in their own awake directory, as `{recorded, state}`
 */
export const GOVERNOR_REPORT = `${AWAKE_COMMAND} report`;

/** the setup session's lock, which every scheduled update run holds */
export const SESSION_LOCK_PATH = `${SESSION_DIRECTORY}/session.lock`;

/**
 * takes the recorded state out of a governor report
 * @param report the report's text
 * @returns the recorded state, or an empty record when none is recorded
 */
export function reportedGovernorState(report: string): unknown {
  const parsed: unknown = JSON.parse(report);

  return isRecord(parsed) && isRecord(parsed.state) ? parsed.state : {};
}
