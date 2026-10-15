import { GUEST_ROOT } from '../guest-root.js';

import { download, downloadText, link, run, temporary } from './context.js';

import type { ReleaseInstallTools } from '../../drivers/install-sources.js';

/** the installer helpers every component installer borrows */
export const tools: ReleaseInstallTools = {
  download,
  downloadText,
  link,
  run,
  temporary,
  toolsDirectory: `${GUEST_ROOT}/tools`,
};
