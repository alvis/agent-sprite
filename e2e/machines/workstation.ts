import { describe, it } from 'vitest';

import { runConfiguredScenario } from './workstation/configuration';
import { runLifecycleScenario } from './workstation/lifecycle';
import { runNoNetworkScenario } from './workstation/network';

import type { MachineHarness } from './harness';

/**
 * registers the scenarios every machine type passes alike, each creating
 * workstations of the harness's type through the packed CLI
 * @param harness the machine type's harness, scoped to this run
 */
export function describeWorkstationSuite(harness: MachineHarness): void {
  describe(`${harness.provider.name} workstation lifecycle`, () => {
    it.concurrent(
      'should create non-interactively and pass every workstation command',
      async (context) => runLifecycleScenario(harness, context),
    );
    it.concurrent(
      'should run a workstation with no private network and install no network tool',
      async (context) => runNoNetworkScenario(harness, context),
    );
    it.concurrent(
      'should create non-interactively with a proxy, a git identity, a runtime env file and no GitHub access or plugins',
      async (context) => runConfiguredScenario(harness, context),
    );
  });
}
