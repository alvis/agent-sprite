import { readFile } from 'node:fs/promises';

import { isRecord } from '../../../../guest/records.js';

/** the bounded result the host parses */
interface HubProbeResult {
  /** whether the gateway answered its model catalogue request */
  reachable: boolean;
  /** HTTP status the gateway answered with */
  status?: number;
  /** bounded reason the gateway could not be reached */
  reason?: string;
}

const requestTimeoutMs = 10_000;

/**
 * reads the gateway record the host wrote beside this probe
 * @param path root-owned record path the host passes as the only argument
 * @returns the model catalogue endpoint and client key, or a failure reason
 */
async function readHubRecord(
  path: string | undefined,
): Promise<{ models: string; apiKey: string } | { reason: string }> {
  if (!path) {
    return { reason: 'gateway record path missing' };
  }
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    return { reason: 'gateway record missing' };
  }
  try {
    const record: unknown = JSON.parse(contents);
    if (
      isRecord(record) &&
      typeof record.models === 'string' &&
      typeof record.apiKey === 'string'
    ) {
      return { models: record.models, apiKey: record.apiKey };
    }
  } catch {
    // reported below as a malformed record
  }

  return { reason: 'gateway record malformed' };
}

/**
 * asks the gateway for its model catalogue, which generates no model turn
 * @param path root-owned record path
 * @returns reachability of the recorded gateway
 */
async function probe(path: string | undefined): Promise<HubProbeResult> {
  const record = await readHubRecord(path);
  if ('reason' in record) {
    return { reachable: false, reason: record.reason };
  }
  try {
    const response = await fetch(new URL(record.models), {
      headers: { Authorization: `Bearer ${record.apiKey}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });

    return { reachable: response.ok, status: response.status };
  } catch {
    return { reachable: false, reason: 'gateway request failed' };
  }
}

process.stdout.write(JSON.stringify(await probe(process.argv[2])));
