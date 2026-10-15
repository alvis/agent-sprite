import { pathToFileURL } from 'node:url';

import { awakeDirectory, productionContext, rootOfModule } from './context.js';
import { readGovernorState } from './state-file.js';

import type { GovernorReport } from './state.js';

// guest kernel: imports only Node built-ins and other guest code, and names no
// provider. The host runs this entry as root to read the governor state: the
// record lives in an agent-writable directory, so it is read here as
// untrusted data, never by following a link the agent could plant, and only
// the validated report reaches standard output

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.stdout.write(
    `${JSON.stringify(await reportGovernorState(rootOfModule(import.meta.url)))}\n`,
  );
}

/**
 * reads the governor state record under a guest root
 * @param root directory the guest kernel was deployed under
 * @returns the validated record, or why none could be read
 */
export async function reportGovernorState(
  root: string,
): Promise<GovernorReport> {
  const context = await productionContext(root);

  return readGovernorState(awakeDirectory(context), context.owners).catch(
    () => ({
      recorded: false,
      reason: 'the record could not be read',
    }),
  );
}
