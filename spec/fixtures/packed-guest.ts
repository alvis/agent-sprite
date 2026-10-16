import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';

// the packaged guest proofs locate the packed CLI under test

/**
 * locates the packed package under test
 * @returns package root of the packed CLI
 */
export async function packageRoot(): Promise<string> {
  const packedBin = process.env.OPEN_AGENT_PACKED_BIN;
  if (!packedBin) {
    throw new Error('Guest payload proofs require the packed E2E runner');
  }

  return dirname(dirname(await realpath(packedBin)));
}
