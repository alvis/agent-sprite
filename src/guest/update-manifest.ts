import { readFile, writeFile } from 'node:fs/promises';

import { isRecord } from './records.js';

import type { ComponentOutcome } from './component-outcome.js';

/** maintenance-owned fields merged into the latest complete manifest */
export interface ManifestUpdate {
  installedVersions?: Record<string, string>;
  /** what the run did to each component; null removes the outcomes an earlier run left */
  componentOutcomes?: Record<string, ComponentOutcome> | null;
  lastAttemptedUpdate?: string;
  lastSuccessfulUpdate?: string;
  lastUpdateStatus?: 'succeeded' | 'failed';
  lastUpdateError?: string;
  /** why the schedule runs on a fallback; null clears it once nothing needs reporting */
  lastUpdateDiagnostic?: string | null;
}

const updateFields = [
  'installedVersions',
  'componentOutcomes',
  'lastAttemptedUpdate',
  'lastSuccessfulUpdate',
  'lastUpdateStatus',
  'lastUpdateError',
  'lastUpdateDiagnostic',
] as const;

/**
 * rereads and merges updater-owned fields while the caller holds the guest lock
 * @param path installation manifest path
 * @param update changed maintenance fields
 * @returns after the fresh manifest has been persisted
 */
export async function mergeManifestUpdate(
  path: string,
  update: ManifestUpdate,
): Promise<void> {
  const manifest: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isRecord(manifest) || manifest.schema !== 1) {
    throw new Error('Managed installation manifest is malformed');
  }
  for (const field of updateFields) {
    if (!Object.hasOwn(update, field)) {
      continue;
    }
    const value = update[field];
    if (value === null) {
      delete manifest[field];
    } else {
      manifest[field] = value;
    }
  }
  if (update.lastUpdateStatus === 'succeeded') {
    delete manifest.lastUpdateError;
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });
}
