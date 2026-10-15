import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { GUEST_ROOT } from '../guest-root.js';
import { resolveTrustedFile } from '../native-files.js';
import { isRecord } from '../records.js';

import { probeVersionAsRoot } from './agent.js';
import { tools } from './tools.js';

import type { NetworkComponent } from '../../drivers/component-types.js';
import type {
  ReleaseInstaller,
  ReleaseInstallTools,
} from '../../drivers/install-sources.js';

import type { ComponentLedger } from './ledger.js';

const RELEASE = /^\d+\.\d+\.\d+$/;

/**
 * installs the selected network's tool through the installer module the
 * network's driver deploys, and leaves alone a tool that is already at the
 * feed's latest stable release; a network that installs nothing is not
 * recorded, so nothing is installed for it
 * @param networks the selected network the host recorded for this guest, if it installs a tool
 * @param ledger records what the run does to each component
 */
export async function installNetworks(
  networks: readonly NetworkComponent[],
  ledger: ComponentLedger,
): Promise<void> {
  for (const network of networks) {
    const installer: unknown = await import(
      pathToFileURL(
        await resolveTrustedFile(join(GUEST_ROOT, network.installer)),
      ).href
    );
    if (!isReleaseInstaller(installer)) {
      throw new Error(`No installer exists for network ${network.id}`);
    }
    await ledger.ensure({
      component: network.component,
      resolve: async () => ({
        version: await validVersion(network, installer, tools),
      }),
      installed: async () => probeVersionAsRoot(tools.run, network.probe),
      install: async ({ version }) =>
        installer.installRelease(network, tools, version),
    });
  }
}

/**
 * reads the latest version from a driver's installer and refuses anything but a dotted release
 * @param network the network as the guest recorded it
 * @param installer the network's loaded installer
 * @param tools installer helpers core lends
 * @returns the bare dotted version the driver reported
 * @throws {Error} when the driver reports anything else
 */
async function validVersion(
  network: NetworkComponent,
  installer: ReleaseInstaller,
  tools: ReleaseInstallTools,
): Promise<string> {
  // the module is driver code loaded at run time, so its answer is untrusted
  const version: unknown = await installer.latestRelease(network, tools);
  if (typeof version !== 'string' || !RELEASE.test(version)) {
    throw new Error(
      `The latest release of ${network.id} is not a dotted version`,
    );
  }

  return version;
}

/**
 * tells whether a loaded module installs a network release
 * @param module loaded installer module
 * @returns true when the module exports `latestRelease` and `installRelease`
 */
function isReleaseInstaller(module: unknown): module is ReleaseInstaller {
  return (
    isRecord(module) &&
    typeof module.latestRelease === 'function' &&
    typeof module.installRelease === 'function'
  );
}
