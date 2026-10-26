import type { TestContext } from 'vitest';

import type { CommandData } from '#application/data';

import type { MachineCli } from '../cli';
import type { HarnessProcess, OlderRelease, UpdateRecord } from '../guest';
import type { MachineHarness } from '../harness';
import type { ServiceProcess } from '../providers';

/** context of one concurrent machine scenario */
export type WorkstationCaseContext = Pick<
  TestContext,
  'expect' | 'signal' | 'annotate'
>;

/** drivers and test context shared by every lifecycle stage */
export interface LifecycleContext extends WorkstationCaseContext {
  harness: MachineHarness;
  cli: MachineCli;
  name: string;
}

/** lifecycle after a successful create */
export interface CreatedLifecycle extends LifecycleContext {
  create: CommandData['create'];
  id: string;
}

/** lifecycle after taking the original service snapshot */
export interface RunningLifecycle extends CreatedLifecycle {
  before: ServiceProcess[];
}

/** lifecycle with a stale harness and a tool link removed */
export interface PreparedLifecycle extends RunningLifecycle {
  release: OlderRelease;
  session: HarnessProcess[];
  statusBefore: UpdateRecord;
}

/** lifecycle after the first forced update */
export interface UpdatedLifecycle extends PreparedLifecycle {
  statusAfter: UpdateRecord;
  firstMs: number;
}

/** drivers and test context shared by workstation variants */
export interface VariantContext extends WorkstationCaseContext {
  harness: MachineHarness;
  cli: MachineCli;
  name: string;
}
