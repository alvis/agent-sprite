import { readComponentCatalog } from './component-catalog.js';
import { AGENT_HOME } from './guest-root.js';
import { readHarnessCatalog } from './harness-catalog.js';
import { resolveTrustedFile } from './native-files.js';
import { runChild } from './run-child.js';
import { SYSTEM_PROBES } from './system-probes.js';

/** longest one version probe may run; a large binary read from a cold volume on a shared CPU can take tens of seconds */
const PROBE_TIMEOUT_MS = 60_000;

/**
 * probes installed versions through the unprivileged guest account
 * @param environment fixed guest process environment
 * @param onStep records the exact failing probe
 * @returns installed version map
 */
export async function probeInstalledVersions(
  environment: NodeJS.ProcessEnv,
  onStep: (step: string) => void,
): Promise<Record<string, string>> {
  const runuser = await resolveTrustedFile('/usr/sbin/runuser');
  const components = await readComponentCatalog();
  const probes = [
    ...SYSTEM_PROBES,
    ...components.networks.map(
      (network) => [network.component, network.probe] as const,
    ),
    ...(await readHarnessCatalog()).flatMap((harness) =>
      [harness, ...(harness.adapter ? [harness.adapter] : [])].map(
        (entry) => [entry.component, entry.probe] as const,
      ),
    ),
    [components.agent.component, components.agent.probe] as const,
    [components.runtime.component, components.runtime.probe] as const,
  ];

  const versions: Record<string, string> = {};
  for (const [name, command] of probes) {
    onStep(`installed version probe (${name})`);
    // waited for without blocking, so the awake hold keeps refreshing
    versions[name] = (
      await runChild(runuser, ['-u', 'agent', '--', ...command], {
        env: environment,
        // the updater's directory may be one the agent cannot read
        cwd: AGENT_HOME,
        timeoutMs: PROBE_TIMEOUT_MS,
      })
    ).trim();
  }

  return versions;
}
