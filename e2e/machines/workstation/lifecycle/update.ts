import { codexTool } from '#adapters/drivers/harnesses/codex/tools';

import { successData } from '../../cli';
import {
  installOlderRelease,
  loggedOutcomes,
  probeStaleComponent,
  profileTools,
  readEnvironment,
  readHarnessSession,
  readLoginVersion,
  readToolState,
  readUpdateLog,
  readUpdateRecord,
  removeToolLink,
  replacedSession,
  STALE_COMPONENT,
  startHarnessSession,
  updateOutcomes,
  watchHolders,
  exposedEntries,
  guestEntries,
} from '../../guest';
import { COMMAND_TIMEOUT_MS } from '../limits';

import type { UpdateToolOutcome } from '#domain/observations/updates';

import type { ToolState, UpdateRecord } from '../../guest';
import type {
  PreparedLifecycle,
  RunningLifecycle,
  UpdatedLifecycle,
} from '../context';

/**
 * finds what the last update did to one tool
 * @param status what the updater recorded
 * @param tool tool name
 * @returns the tool's outcome, absent when the run did not reach it
 */
function toolOutcome(
  status: UpdateRecord,
  tool: string,
): UpdateToolOutcome | undefined {
  return status.tools.find(({ name }) => name === tool);
}

/**
 * installs an older harness and removes one tool link
 * @param context run drivers and prior observations
 * @returns the older release, live session and original update status
 */
export async function prepareUpdate(
  context: RunningLifecycle,
): Promise<Pick<PreparedLifecycle, 'release' | 'session' | 'statusBefore'>> {
  const { create, name, expect, harness } = context;
  const { provider } = harness;
  // a harness genuinely out of date: its previous release, installed by
  // its owning account through the guest's own npm, with a session of it
  // running through the update as an ACP agent session would
  expect(create.profile.harnesses).toContain(codexTool.name);

  const release = await installOlderRelease(provider, name, codexTool);
  const session = await startHarnessSession(provider, name);

  expect(await readLoginVersion(provider, name, codexTool.name)).toBe(
    release.older,
  );

  // an update must also repair what is missing, not only upgrade what
  // is there, so remove a tool's link before forcing the update
  await removeToolLink(provider, name);
  const statusBefore = await readUpdateRecord(provider, name);

  return { release, session, statusBefore };
}

/**
 * runs the first forced update and checks service continuity
 * @param context run drivers and prior observations
 * @returns the new update status and elapsed time
 */
export async function runFirstUpdate(
  context: PreparedLifecycle,
): Promise<Pick<UpdatedLifecycle, 'statusAfter' | 'firstMs'>> {
  const { cli, name, signal, expect, id, before, statusBefore, harness } =
    context;
  const { provider } = harness;
  const firstStartedAt = performance.now();
  // the setup session and the updater keep the workstation awake as
  // managed holds, and release them when the update ends
  const holdWatch = await watchHolders(provider, name, async () =>
    cli.json(
      ['setup', name, '--section', 'tools', '--update'],
      COMMAND_TIMEOUT_MS,
      signal,
    ),
  );
  const update = successData(holdWatch.result, 'setup');
  const firstMs = Math.round(performance.now() - firstStartedAt);
  const statusAfter = await readUpdateRecord(provider, name);

  expect(update).toMatchObject({
    section: 'tools',
    tools: 'updated',
    components: { installed: expect.any(Number), failed: 0 },
    machine: { name, id },
  });
  expect(holdWatch.sources).toEqual(
    expect.arrayContaining(['session', 'update']),
  );
  expect(holdWatch.openHoldsAfter).toBe(0);
  expect(await provider.snapshotServices(name)).toEqual(before);
  expect(statusAfter).toMatchObject({
    finishedAt: expect.any(String),
    links: 'restored',
  });
  expect(Date.parse(statusAfter.lastSuccess ?? '')).toBeGreaterThan(
    Date.parse(statusBefore.lastSuccess ?? '') || 0,
  );
  expect(
    statusAfter.tools.filter(({ outcome }) => outcome === 'failed'),
  ).toEqual([]);

  return { statusAfter, firstMs };
}

/**
 * checks the repaired link and upgraded live harness
 * @param context run drivers and prior observations
 */
export async function checkUpgrade(context: UpdatedLifecycle): Promise<void> {
  const { name, expect, annotate, release, session, statusAfter, harness } =
    context;
  const { provider } = harness;
  // the removed link was restored before the updater ran, which found
  // the tool itself in place
  const relinked = toolOutcome(statusAfter, STALE_COMPONENT);

  expect(relinked).toMatchObject({
    manager: 'brew',
    outcome: expect.stringMatching(/^(?:installed|skipped)$/),
    to: expect.stringMatching(/^\d+\.\d+\.\d+/),
  });
  expect(await probeStaleComponent(provider, name)).toContain(
    relinked?.to?.replace(/_\d+$/, ''),
  );

  // the older harness was upgraded in place: a new session starts the
  // new release, while the running session keeps every process and the
  // files it started from
  const upgraded = toolOutcome(statusAfter, codexTool.name);

  await annotate(
    `${codexTool.name} ${release.older} upgraded to ${upgraded?.to} (latest ${release.latest} before the update) with session processes ${session.map(({ pid }) => pid).join(', ')} running`,
  );
  expect(upgraded).toMatchObject({
    manager: 'npm',
    outcome: 'installed',
    from: release.older,
    to: expect.stringMatching(/^\d+\.\d+\.\d+$/),
  });
  expect(upgraded?.to).not.toBe(release.older);
  expect(await readLoginVersion(provider, name, codexTool.name)).toBe(
    upgraded?.to,
  );
  expect(await readHarnessSession(provider, name)).toEqual(
    replacedSession(session, (pattern) => expect.stringMatching(pattern)),
  );
}

/**
 * checks that a repeated update leaves every tool and service unchanged
 * @param context run drivers and prior observations
 */
export async function checkRepeatedUpdate(
  context: UpdatedLifecycle,
): Promise<void> {
  const { cli, name, signal, expect, annotate, create, id, firstMs, harness } =
    context;
  const { provider } = harness;
  // nothing changed upstream since that update, so an immediate second
  // forced update finds every tool current and installs nothing
  const toolsAfterFirst = await readToolState(provider, name);
  const secondStartedAt = performance.now();
  const repeated = successData(
    await cli.json(
      ['setup', name, '--section', 'tools', '--update'],
      COMMAND_TIMEOUT_MS,
      signal,
    ),
    'setup',
  );
  const secondMs = Math.round(performance.now() - secondStartedAt);
  const statusRepeated = await readUpdateRecord(provider, name);
  const recorded = (await readEnvironment(provider, name)).tools
    .map(({ name: tool }) => tool)
    .sort();

  await annotate(
    `forced update: first ${firstMs} ms (re-linked ${STALE_COMPONENT}, upgraded ${codexTool.name}), repeated ${secondMs} ms (all skipped)`,
  );
  // the outcomes name every tool environment.json records, which holds
  // every one the profile's drivers install, so a tool cannot be
  // skipped unseen
  expect(recorded).toEqual(
    expect.arrayContaining(profileTools(create.profile)),
  );
  expect(repeated).toMatchObject({
    section: 'tools',
    tools: 'updated',
    components: { installed: 0, skipped: recorded.length, failed: 0 },
    machine: { name, id },
  });
  expect(updateOutcomes(statusRepeated)).toEqual(
    Object.fromEntries(recorded.map((tool) => [tool, 'skipped'])),
  );

  await checkRepeatedUnchanged(context, { toolsAfterFirst, statusRepeated });
}

/**
 * checks independent guest records after the repeated update
 * @param context run drivers and prior observations
 * @param snapshot tool files and update status after the repeated run
 * @param snapshot.toolsAfterFirst file fingerprint after the first update
 * @param snapshot.statusRepeated status after the repeated update
 */
async function checkRepeatedUnchanged(
  context: UpdatedLifecycle,
  snapshot: { toolsAfterFirst: ToolState; statusRepeated: UpdateRecord },
): Promise<void> {
  const { name, expect, before, session, statusAfter, harness } = context;
  const { provider } = harness;
  const { toolsAfterFirst, statusRepeated } = snapshot;

  // independent evidence that nothing changed: the kegs, the system
  // links and the npm manifests are the very same files, and the run's
  // own log reports the same outcomes
  expect(await readToolState(provider, name)).toEqual(toolsAfterFirst);
  expect(loggedOutcomes(await readUpdateLog(provider, name))).toEqual(
    updateOutcomes(statusRepeated),
  );
  expect(statusRepeated.links).toBe('restored');
  expect(Date.parse(statusRepeated.lastSuccess ?? '')).toBeGreaterThan(
    Date.parse(statusAfter.lastSuccess ?? ''),
  );
  expect(statusRepeated.tools.map(({ name: tool, to }) => [tool, to])).toEqual(
    statusAfter.tools.map(({ name: tool, to }) => [tool, to]),
  );
  expect(await provider.snapshotServices(name)).toEqual(before);
  expect(await readHarnessSession(provider, name)).toEqual(
    replacedSession(session, (pattern) => expect.stringMatching(pattern)),
  );
  // root runs everything under the guest root, so it must be root's alone
  expect(exposedEntries(await guestEntries(provider, name))).toEqual([]);
}
