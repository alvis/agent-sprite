import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';

import {
  COMPONENT_CATALOG_FILE,
  HARNESS_CATALOG_FILE,
  registeredHarnessCatalog,
  seedComponentCatalog,
} from '#core/guest-catalogs';
import { GUEST_LEAVES } from '#core/guest-leaves';
import { driverModule, kernelModule } from '#guest/guest-root';
import { runBoundedIO } from '#operation';

import type { GuestPayload } from '#drivers/contracts';

/** root-owned and private: only root executes or imports these */
const ROOT_SCRIPT_MODE = 0o700;
/** root-owned and readable by every account, never writable by one */
const SHARED_SCRIPT_MODE = 0o755;
/** mode of a root-owned command every account runs, such as the awake command */
export const COMMAND_MODE = SHARED_SCRIPT_MODE;
/** mode of the data catalogs, which are read but never executed */
export const CATALOG_FILE_MODE = 0o644;
/**
 * the one table of idle governor directory owners and modes: `run` and the
 * managed awake directory only root writes, and the agent account reads the
 * managed holds through its group but can neither add, replace nor remove one;
 * the shared awake directory is written by root and the agent account alone,
 * without a sticky bit, so either replaces the other's state by rename. Both
 * awake directories are set-group-id, so every file in them belongs to the
 * agent group without any file ever being chowned
 */
export const IDLE_DIRECTORY_MODES = {
  run: { group: 'root', mode: '0755' },
  awake: { group: 'agent', mode: '2770' },
  managedAwake: { group: 'agent', mode: '2750' },
} as const;
/** the transaction worker the launcher installs before it stages anything else */
const WORKER_MODULE = kernelModule('guest-transaction.js');
// the one table of kernel module modes: a module only root executes or imports
// is private, and one an agent-run script also imports stays readable. Driver
// modules take their mode from the account their driver declares, and every
// deploy path reads its mode from here through `payloadMode`
const rootOnlyKernel = [
  'chrome.js',
  'component-outcome.js',
  'guest-transaction.js',
  'guest-transaction/hold.js',
  'guest-transaction/request.js',
  'guest-transaction/runtime.js',
  'homebrew.js',
  'install-tools.js',
  'install-tools/agent.js',
  'install-tools/chrome.js',
  'install-tools/context.js',
  'install-tools/formula.js',
  'install-tools/homebrew.js',
  'install-tools/leftovers.js',
  'install-tools/ledger.js',
  'install-tools/link-record.js',
  'install-tools/networks.js',
  'install-tools/npm.js',
  'install-tools/rust.js',
  'install-tools/tools.js',
  'run-child.js',
  'rust.js',
  'supervisor/client.js',
  'supervisor/control.js',
  'supervisor/daemon.js',
  'supervisor/entries.js',
  'supervisor/fault.js',
  'supervisor/log.js',
  'supervisor/main.js',
  'supervisor/processes.js',
  'supervisor/protocol.js',
  'supervisor/runner.js',
  'supervisor/server.js',
  'supervisor/store.js',
  'supervisor/supervisor.js',
  'supervisor/timer.js',
  'system-probes.js',
  'update-manifest.js',
  'update-options.js',
  'update-schedule.js',
  'update-versions.js',
  'updater-diagnostics.js',
  'updater.js',
  'updater/executables.js',
  'workstation-profile.js',
];
const sharedKernel = [
  'component-catalog.js',
  'guest-root.js',
  'harness-catalog.js',
  'idle/adapter.js',
  'idle/agent-apply.js',
  'idle/apply.js',
  'idle/awake.js',
  'idle/command.js',
  'idle/context.js',
  'idle/deadline.js',
  'idle/dispatch.js',
  'idle/files.js',
  'idle/governor.js',
  'idle/hold.js',
  'idle/holders.js',
  'idle/hook-input.js',
  'idle/lock.js',
  'idle/machine-clock.js',
  'idle/names.js',
  'idle/options.js',
  'idle/permission.js',
  'idle/process-identity.js',
  'idle/provider-facts.js',
  'idle/recompute.js',
  'idle/report.js',
  'idle/settings.js',
  'idle/state-file.js',
  'idle/state.js',
  'idle/tick-record.js',
  'native-files.js',
  'records.js',
];
const kernelModes = new Map<string, number>([
  ...rootOnlyKernel.map((module): [string, number] => [
    kernelModule(module),
    ROOT_SCRIPT_MODE,
  ]),
  ...sharedKernel.map((module): [string, number] => [
    kernelModule(module),
    SHARED_SCRIPT_MODE,
  ]),
]);

/** a compiled guest module and how it is staged */
interface GuestModule {
  /** deployed path under the guest root, which is also its path under `lib` */
  name: string;
  /** compiled source in the package */
  url: URL;
  /** staging mode */
  mode: number;
}

/**
 * locates a compiled module in the package
 * @param name deployed path under the guest root
 * @returns URL of the compiled module, which `lib` mirrors path for path
 */
function compiledUrl(name: string): URL {
  return new URL(`../../../../lib/${name}`, import.meta.url);
}

/**
 * refuses a module name that is not already a plain relative path, so a
 * `.` or `..` segment cannot pass a folder prefix test and escape its folder
 * @param name deployed path under the guest root
 * @throws {Error} when the name is absolute or differs from its normalised form
 */
function checkModuleName(name: string): void {
  if (
    posix.isAbsolute(name) ||
    posix.normalize(name) !== name ||
    name.split('/').some((segment) => segment === '' || segment === '..')
  ) {
    throw new Error(`Guest module ${name} is not a plain relative path`);
  }
}

/**
 * lists the compiled guest modules every registered driver contributes
 * @returns driver modules, which are staged whether or not the driver is selected
 * @throws {Error} when a driver declares a module outside its own guest folder
 */
function driverModules(): GuestModule[] {
  const { providers, ...folders } = GUEST_LEAVES;
  // a provider contributes only its awake adapter
  const contributions = [
    ...Object.entries(providers).map(
      ([id, { awakeAdapter }]): [string, readonly GuestPayload[]] => [
        `providers/${id}`,
        awakeAdapter ? [awakeAdapter] : [],
      ],
    ),
    ...Object.entries(folders).flatMap(([kind, leaves]) =>
      Object.entries(leaves).map(
        ([id, { guest }]): [string, readonly GuestPayload[]] => [
          `${kind}/${id}`,
          guest,
        ],
      ),
    ),
  ];

  return contributions.flatMap(([folder, guest]) =>
    guest.map(({ module, account }) => {
      checkModuleName(module);
      if (!module.startsWith(driverModule(folder, ''))) {
        throw new Error(
          `Guest module ${module} is outside the guest folder of ${folder}`,
        );
      }

      return {
        name: module,
        url: compiledUrl(module),
        mode: account === 'root' ? ROOT_SCRIPT_MODE : SHARED_SCRIPT_MODE,
      };
    }),
  );
}

/**
 * lists every compiled module the guest root mirrors, refusing two modules
 * that would land on the same path
 * @returns core modules followed by the drivers' modules
 * @throws {Error} when two modules share a deployed name
 */
function guestModules(): GuestModule[] {
  const modules = [
    ...[...kernelModes].map(([name, mode]) => ({
      name,
      url: compiledUrl(name),
      mode,
    })),
    ...driverModules(),
  ];
  const seen = new Set<string>();
  for (const { name } of modules) {
    checkModuleName(name);
    if (seen.has(name)) {
      throw new Error(
        `Guest module ${name} is deployed by more than one owner`,
      );
    }
    seen.add(name);
  }

  return modules;
}

/**
 * lists every compiled guest module staged on the guest
 * @returns core payload names followed by the drivers' modules
 */
export function compiledPayloads(): string[] {
  return guestModules().map(({ name }) => name);
}

/**
 * names the mode a deployed module has, whichever path deploys it
 * @param name deployed path under the guest root
 * @returns the module's one staged mode
 * @throws {Error} when no module is deployed under the name
 */
export function payloadMode(name: string): number {
  const module = guestModules().find((candidate) => candidate.name === name);
  if (!module) {
    throw new Error('Unknown bundled guest payload');
  }

  return module.mode;
}

/**
 * resolves a compiled guest payload in both source and installed layouts
 * @param filename fixed bundled asset name
 * @returns URL of the compiled package asset
 */
export function payloadUrl(filename: string): URL {
  // the node bootstrap is a shell script, deployed beside the kernel it
  // belongs to, so it is not a staged module
  if (filename === kernelModule('bootstrap-node.sh')) {
    return compiledUrl(filename);
  }
  const module = guestModules().find(({ name }) => name === filename);
  if (!module) {
    throw new Error('Unknown bundled guest payload');
  }

  return module.url;
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
 * loads all compiled runtime assets and the seed harness list before the worker admits requests
 * @returns fixed manager payload staging frame
 */
export async function guestPayloadFrame(): Promise<string> {
  const files = await Promise.all(
    guestModules()
      .filter(({ name }) => name !== WORKER_MODULE)
      .map(async ({ name, url, mode }) => ({
        name,
        contents: await runBoundedIO(async () => readFile(url, 'utf8')),
        mode,
      })),
  );

  // seeds the harness and component lists for the scripts staged above; the
  // host replaces them with the selected drivers, which a later stage must
  // not overwrite
  const catalog = {
    name: HARNESS_CATALOG_FILE,
    contents: `${JSON.stringify(registeredHarnessCatalog(), null, 2)}\n`,
    mode: CATALOG_FILE_MODE,
    ifAbsent: true,
  };

  // the host replaces the seeded component list with the selected provider's
  // and agent's
  const components = {
    name: COMPONENT_CATALOG_FILE,
    contents: `${JSON.stringify(seedComponentCatalog(), null, 2)}\n`,
    mode: CATALOG_FILE_MODE,
    ifAbsent: true,
  };

  return JSON.stringify([...files, catalog, components]);
}
