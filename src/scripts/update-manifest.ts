import { readFile, writeFile } from 'node:fs/promises';

import { isRecord } from './records.js';

/** maintenance-owned fields merged into the latest complete manifest */
export interface ManifestUpdate {
  installedVersions?: Record<string, string>;
  lastAttemptedUpdate?: string;
  lastSuccessfulUpdate?: string;
  lastUpdateStatus?: 'succeeded' | 'failed';
  lastUpdateError?: string;
}

const updateFields = [
  'installedVersions',
  'lastAttemptedUpdate',
  'lastSuccessfulUpdate',
  'lastUpdateStatus',
  'lastUpdateError',
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
    if (Object.hasOwn(update, field)) {
      manifest[field] = update[field];
    }
  }
  if (update.lastUpdateStatus === 'succeeded') {
    delete manifest.lastUpdateError;
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });
}
