/** validated integration selection consumed by the updater */
export interface UpdateManifestSelection {
  integrations?: { tailscale: boolean };
}
/** exact services and scheduling mode for one update */
export interface UpdateOptions {
  force: boolean;
  services: string[];
}

const updaterArgumentCount = 2;
const forcedUpdateArgumentCount = 3;

/**
 * derives managed services from the manifest read under the updater lock
 * @param manifest validated guest installation manifest
 * @param argv process arguments
 * @returns update mode and exact services
 */
export function updateOptions(
  manifest: UpdateManifestSelection,
  argv: readonly string[],
): UpdateOptions {
  if (
    argv.length !== updaterArgumentCount &&
    (argv.length !== forcedUpdateArgumentCount || argv[2] !== '--force')
  ) {
    throw new Error('Invalid managed updater arguments');
  }

  return {
    force: argv.length === forcedUpdateArgumentCount,
    services: [
      't3-code',
      ...(manifest.integrations?.tailscale === false ? [] : ['tailscaled']),
    ],
  };
}
