import { readFile } from 'node:fs/promises';

import { runBoundedIO } from '#operation';

export const ROOT_SCRIPT_MODE = 0o700;
const SHARED_SCRIPT_MODE = 0o755;
const rootPayloads = new Set([
  'install-tools.js',
  'updater.js',
  'guest-transaction.js',
  'guest-transaction/runtime.js',
  'guest-transaction/request.js',
  'tailscale-launcher.js',
]);
export const compiledPayloads = [
  'claude-init-notifications.js',
  'claude-init-probe.js',
  'codex-hooks-trust.js',
  'codex-skills-probe.js',
  'guest-task-hold.js',
  'guest-transaction.js',
  'guest-transaction/request.js',
  'guest-transaction/runtime.js',
  'hub-probe.js',
  'install-tools.js',
  'install-tools/context.js',
  'native-files.js',
  'records.js',
  't3-launcher.js',
  't3-provider-probe.js',
  't3-provider-probe/rpc.js',
  'tailscale-launcher.js',
  'update-manifest.js',
  'update-options.js',
  'update-schedule.js',
  'update-services.js',
  'update-versions.js',
  'updater-diagnostics.js',
  'updater-lifecycle.js',
  'updater.js',
  'updater/executables.js',
  'updater/services.js',
] as const;

/**
 * resolves a compiled guest payload in both source and installed layouts
 * @param filename fixed bundled asset name
 * @returns URL of the compiled package asset
 */
export function payloadUrl(filename: string): URL {
  if (
    filename !== 'bootstrap-node.sh' &&
    !compiledPayloads.some((name) => name === filename)
  ) {
    throw new Error('Unknown bundled guest payload');
  }

  return new URL(`../../../../lib/scripts/${filename}`, import.meta.url);
}

/**
 * reads the installed compiled asset tree, also used by source development
 * @param filename fixed bundled asset name
 * @returns complete compiled payload text
 */
export async function readGuestPayload(filename: string): Promise<string> {
  const url = payloadUrl(filename);

  return runBoundedIO(async () => readFile(url, 'utf8'));
}

/**
 * loads all compiled runtime assets before the worker admits requests
 * @returns fixed manager payload staging frame
 */
export async function guestPayloadFrame(): Promise<string> {
  const files = await Promise.all(
    compiledPayloads
      .filter((name) => name !== 'guest-transaction.js')
      .map(async (name) => ({
        name,
        contents: await readGuestPayload(name),
        mode: rootPayloads.has(name) ? ROOT_SCRIPT_MODE : SHARED_SCRIPT_MODE,
      })),
  );

  return JSON.stringify(files);
}
