import { readFile } from 'node:fs/promises';

import { isComponentEntry } from './component-catalog.js';
import { GUEST_ROOT } from './guest-root.js';
import { isRecord, isStringArray } from './records.js';

import type { ComponentEntry } from '../drivers/component-types.js';

/** what the guest needs to know about one selected harness */
export interface HarnessEntry {
  /** harness identifier */
  id: string;
  /** key recorded in the manifest's installed versions */
  component: string;
  /** npm package that provides the harness */
  package: string;
  /** program and arguments whose output reports the installed version */
  probe: string[];
  /** environment the ACP agent passes when spawning the harness */
  environment: Record<string, string>;
  /** the ACP adapter the harness provides, installed and upgraded with it */
  adapter?: ComponentEntry;
}

// the host writes this file from the selected harness drivers before any
// guest script that needs it runs; guest code cannot import the host catalog
const CATALOG_PATH = `${GUEST_ROOT}/harnesses.json`;

/**
 * reads the selected harnesses the host recorded on the guest
 * @returns the harnesses in selection order
 * @throws {Error} naming the repair when the host has not written the catalog yet
 */
export async function readHarnessCatalog(): Promise<HarnessEntry[]> {
  const contents = await readFile(CATALOG_PATH, 'utf8').catch(
    (error: unknown) => {
      if (isRecord(error) && error.code === 'ENOENT') {
        throw new Error(
          `Managed harness catalog ${CATALOG_PATH} is missing; run \`open-agent setup <name> --section agent\` to rewrite it`,
        );
      }
      throw error;
    },
  );
  const decoded: unknown = JSON.parse(contents);
  if (!Array.isArray(decoded) || !decoded.every(isHarnessEntry)) {
    throw new Error('Managed harness catalog is malformed');
  }

  return decoded;
}

/**
 * validates one recorded harness at its guest trust boundary
 * @param value untrusted decoded entry
 * @returns whether the entry has every required field
 */
function isHarnessEntry(value: unknown): value is HarnessEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.component === 'string' &&
    typeof value.package === 'string' &&
    /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value.package) &&
    isStringArray(value.probe) &&
    value.probe.length > 0 &&
    isRecord(value.environment) &&
    Object.values(value.environment).every(
      (entry) => typeof entry === 'string',
    ) &&
    (value.adapter === undefined || isComponentEntry(value.adapter))
  );
}
