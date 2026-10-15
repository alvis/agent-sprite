import { AGENT_HOME } from '#guest/guest-root';

import type { ToolOwner } from './contracts.js';

/** home of the system account that owns the Homebrew prefix */
export const LINUXBREW_HOME = '/home/linuxbrew';

/** the default Homebrew prefix, the only one bottles pour at */
export const HOMEBREW_PREFIX = `${LINUXBREW_HOME}/.linuxbrew`;

/** where every tool owner's commands start, its home */
export const OWNER_HOMES: Readonly<Record<ToolOwner, string>> = {
  root: '/root',
  linuxbrew: LINUXBREW_HOME,
  agent: AGENT_HOME,
};
