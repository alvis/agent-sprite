import { GUEST_ROOT } from '#guest/guest-root';
import { HOMEBREW_PREFIX, LINUXBREW_HOME } from '#tools/accounts';

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

/** the governor state record within the awake directory */
export const GOVERNOR_STATE_FILE = 'governor.json';

/** the lock every update run holds */
export const UPDATE_LOCK_PATH = `${GUEST_ROOT}/lock/update.lock`;
