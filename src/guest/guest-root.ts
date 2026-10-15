/**
 * the one guest root every guest path derives from; guest scripts import it as
 * a sibling and host code through `#guest/guest-root`
 */
export const GUEST_ROOT = '/opt/open-agent';

/** managed Node executable under the guest root */
export const GUEST_NODE = `${GUEST_ROOT}/node/bin/node`;

/** home directory of the non-root account that runs the harnesses */
export const AGENT_HOME = '/home/agent';

// the guest root holds a mirror of the compiled guest code (`lib/guest` and
// `lib/drivers/<folder>/guest`), so a relative import resolves to the same
// module in the source tree, the package and the deployed guest

const KERNEL_DIRECTORY = 'guest';

/** directory of the deployed guest kernel */
export const GUEST_KERNEL = `${GUEST_ROOT}/${KERNEL_DIRECTORY}`;

/**
 * names a guest kernel module the way the guest root deploys it
 * @param module path of the compiled module under `src/guest`, such as `updater.js`
 * @returns the module's path relative to the guest root
 */
export function kernelModule(module: string): string {
  return `${KERNEL_DIRECTORY}/${module}`;
}

/**
 * names a driver's guest module the way the guest root deploys it
 * @param folder the driver's folder under `src/drivers`, as `<kind>/<id>`
 * @param module path of the compiled module under the driver's `guest` folder
 * @returns the module's path relative to the guest root
 */
export function driverModule(folder: string, module: string): string {
  return `drivers/${folder}/${KERNEL_DIRECTORY}/${module}`;
}
