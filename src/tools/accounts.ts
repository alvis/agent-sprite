import {
  AGENT_HOME,
  HOMEBREW_PREFIX,
  LINUXBREW_HOME,
} from '#integrations/guest/layout';

import type { ToolOwner } from './contracts';

/** the GitHub CLI in its keg's `opt` link, which only the Homebrew account can change */
export const HOMEBREW_GH = `${HOMEBREW_PREFIX}/opt/gh/bin/gh`;

/** where every tool owner's commands start, its home */
export const OWNER_HOMES: Readonly<Record<ToolOwner, string>> = {
  root: '/root',
  linuxbrew: LINUXBREW_HOME,
  agent: AGENT_HOME,
};
