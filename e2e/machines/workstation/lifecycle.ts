import { checkHookDefinitions, checkHookEvents } from './lifecycle/hooks';
import {
  checkDoctorAndTerminate,
  checkDueSchedule,
  checkRescheduledUpdate,
} from './lifecycle/schedule';
import {
  checkAwakeInstallation,
  checkCommands,
  checkHomebrew,
  createWorkstation,
  inspectServices,
} from './lifecycle/setup';
import {
  checkRepeatedUpdate,
  checkUpgrade,
  prepareUpdate,
  runFirstUpdate,
} from './lifecycle/update';

import type { MachineHarness } from '../harness';

import type { WorkstationCaseContext } from './context';

/**
 * proves the complete workstation lifecycle through installed CLI commands
 * @param harness scoped provider, CLI and cleanup
 * @param context concurrent Vitest assertion and cancellation context
 */
export async function runLifecycleScenario(
  harness: MachineHarness,
  context: WorkstationCaseContext,
): Promise<void> {
  const name = harness.workstationName('b');
  const cli = await harness.isolatedCli('b');
  const base = {
    harness,
    cli,
    name,
    expect: context.expect,
    signal: context.signal,
    annotate: context.annotate,
  };

  await harness.withWorkstation(name, async () => {
    const create = await createWorkstation(base);
    const created = { ...base, create, id: create.machine.id };

    await checkHomebrew(created);
    await checkCommands(created);
    await checkAwakeInstallation(created);
    await checkHookDefinitions(created);
    await checkHookEvents(created);

    const before = await inspectServices(created);
    const running = { ...created, before };
    const prepared = { ...running, ...(await prepareUpdate(running)) };
    const updated = { ...prepared, ...(await runFirstUpdate(prepared)) };

    await checkUpgrade(updated);
    await checkRepeatedUpdate(updated);
    await checkDueSchedule(updated);
    await checkRescheduledUpdate(updated);
    await checkDoctorAndTerminate(updated);
  });
}
