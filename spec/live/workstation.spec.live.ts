import { describe, inject, it } from 'vitest';

import { t3Service } from '#drivers/agents/t3/service';
import { codexTool } from '#drivers/harnesses/codex/tools';
import { tailscaleDaemon } from '#drivers/networks/tailscale/service';
import { GUEST_KERNEL } from '#guest/guest-root';
import { HOMEBREW } from '#guest/homebrew';
import { AWAKE_COMMAND } from '#integrations/guest/awake';

import { successData, tail } from './cli.js';
import {
  BREW_TOOLS,
  brewToolDurations,
  componentDuration,
  expectedComponents,
  expectedOutcomes,
  exposedEntries,
  guestEntries,
  installActivity,
  installOlderRelease,
  makeComponentStale,
  placeOlderNode,
  probeStaleComponent,
  readAwakeTaskExpiry,
  readInstallLog,
  readHarnessSession,
  readHomebrewGit,
  readLoginVersion,
  replacedSession,
  readManifestState,
  checkLockDescriptorInheritance,
  checkManagedHold,
  REFRESH_PROBE_SOURCE,
  runRefreshProbe,
  readAwakeHooks,
  readAwakeInstall,
  readNodeTrees,
  readStoredIntervals,
  readToolState,
  runScheduledEntry,
  sendAwakeEvents,
  sendHookEvents,
  setLastSuccessfulUpdate,
  skippedComponents,
  startHarnessSession,
  STALE_COMPONENT,
  STALE_VERSION,
  watchHolders,
} from './guest.js';
import { createLiveHarness } from './harness.js';
import {
  crashHarnessTurn,
  isAsleep,
  openAgentConnection,
  readGovernor,
  readPauses,
  startAwakeLog,
  startHarnessTurn,
  startTickLog,
  stopAwakeLog,
  waitForToolCall,
  waitForTurnEnd,
  watchRunStates,
} from './idle.js';
import { foreignIdentifiers } from './ownership.js';

import type { ExpectStatic } from 'vitest';

import type { ComponentOutcome } from '#guest/component-outcome';

import type { TerminalStep } from '../fixtures/terminal.js';

import type { ScheduledRun } from './guest.js';
import type { RunSample } from './idle.js';

// budgets sum below the project testTimeout so a slow step fails before vitest
// abandons the test body; observed baseline lifecycles finish in about 3 minutes
const CREATE_TIMEOUT_MS = 20 * 60_000;
const COMMAND_TIMEOUT_MS = 8 * 60_000;
const READ_TIMEOUT_MS = 2 * 60_000;
const DEVICE_TIMEOUT_MS = 60_000;
const DEVICE_POLL_MS = 5_000;
const DAY_MS = 86_400_000;
// whole-second rounding and the delay between the governor's record and the Sprite's answer
const TASK_EXPIRY_TOLERANCE_MS = 3000;
const MINUTE_MS = 60_000;
// longer than the 30 second refresh of a 1 minute hold maximum
const REFRESH_PROBE_MS = 45_000;
// due intervals the default cannot produce
const UPDATE_DUE_DAYS = 3;
const RESCHEDULED_DUE_DAYS = 5;
const GIT_NAME = 'Open Agent Live';
const GIT_EMAIL = 'live@example.invalid';
const DOWN = '\u001B[B';
const ENTER = '\r';
// the interactive answers below assume this dotenv shape
const INTERACTIVE_REQUIRED = ['CLIPROXYAPI_BASE_URL', 'CLIPROXYAPI_API_KEY'];
const INTERACTIVE_UNSET = ['GH_TOKEN', 'GITHUB_TOKEN'];
// a real harness turn routes through the profile's CLIProxyAPI hub
const PROXY_REQUIRED = INTERACTIVE_REQUIRED;
// the readiness findings a workstation without model credentials fails
const MODEL_ACCESS_FAILURE = /gateway/iu;
// anything that would show the missing network taking part in the result
const NETWORK_FAILURE = /tailscale|tailnet|tailscaled|exit node|\bDNS\b/iu;
const SECOND_MS = 1000;
// the Sprite reports its transitions in whole seconds
const TRANSITION_ROUNDING_MS = SECOND_MS;
// the guest's last tick lands up to a second before it stops
const PAUSE_ROUNDING_MS = 2 * SECOND_MS;
// the samples either side of a pause that show what led into and out of it
const PAUSE_CONTEXT_MS = 10 * SECOND_MS;
const IDLE_MINUTES = 1;
// a tool call well past the idle timeout
const LONG_TURN_SECONDS = 150;
// longer than the idle timeout and inside the long tool call
const LONG_QUIET_MS = 90_000;
const SHORT_TURN_SECONDS = 75;
// inside the short tool call, where nothing but the turn keeps the Sprite awake
const SHORT_QUIET_MS = 50_000;
const SHORT_HOLD_MAX_MINUTES = 2;
// a tool call that outlasts the short hold maximum
const CRASH_TURN_SECONDS = 400;
// how long the Sprite may take to sleep once nothing keeps it awake
const SLEEP_GRACE_MS = 2 * MINUTE_MS;
// how long a sleep is left undisturbed, well past the pause the guest's ticks can show
const OBSERVED_SLEEP_MS = 15_000;
// a hold refresh and the heartbeat it records are written moments apart
const HOLD_REFRESH_SKEW_MS = 5 * SECOND_MS;

/**
 * checks that a scheduled entry ran end to end: it exited cleanly and the
 * updater process started once and exited cleanly, so an update that was not
 * due was still decided by the updater
 * @param expect the test's own assertion function
 * @param run what the entry did
 */
function expectCompletedRun(expect: ExpectStatic, run: ScheduledRun): void {
  expect(run.exitStatus).toBe(0);
  expect(run.updaterRuns).toEqual([
    { script: `${GUEST_KERNEL}/updater.js`, exitCode: 0 },
  ]);
}

/**
 * summarises run-state samples for an annotation
 * @param samples provider reads in order
 * @returns each distinct state with how often it was read
 */
function describeSamples(samples: readonly RunSample[]): string {
  const states = new Map<string, number>();
  for (const { status, lastRunningAt } of samples) {
    const key = `${status} (last running ${lastRunningAt ?? 'never'})`;
    states.set(key, (states.get(key) ?? 0) + 1);
  }

  return [...states].map(([state, count]) => `${count}x ${state}`).join(', ');
}

/**
 * reads the release an update left a component at
 * @param outcome what the update did to the component, absent when it did nothing
 * @returns the bare dotted version, empty when none was recorded
 */
function versionOf(outcome: ComponentOutcome | undefined): string {
  return outcome?.version ?? '';
}

/**
 * reads a recorded instant, so a missing one fails every comparison
 * @param value ISO 8601 instant, or nothing when none was recorded
 * @returns epoch milliseconds, or NaN when nothing was recorded
 */
function instant(value: string | undefined): number {
  return value === undefined ? Number.NaN : Date.parse(value);
}

const harness = await createLiveHarness(inject('live'));
const { cli, cleanup, provider } = harness;

/**
 * answers every interactive create prompt for one named workstation
 * @param name workstation name typed at the name prompt
 * @returns prompts and keys in their on-screen order
 */
function interactiveCreateSteps(name: string): TerminalStep[] {
  return [
    // two providers are registered, so the first, Fly Sprite, is chosen
    { waitFor: 'Provider', input: ENTER },
    // T3 Code declares two release channels, so the default, stable, is chosen
    { waitFor: 'Release channel', input: ENTER },
    { waitFor: 'Harnesses', input: ENTER },
    { waitFor: 'Network', input: ENTER },
    { waitFor: 'Use an exit node?', input: 'n' },
    { waitFor: 'Route harnesses through CLIProxyAPI?', input: 'y' },
    { waitFor: 'Suspend after idle', input: ENTER },
    { waitFor: 'Workstation name:', input: name },
    { waitFor: `${name}│`, input: ENTER },
    { waitFor: 'Skip GitHub access', input: DOWN },
    { waitFor: '› Skip GitHub access', input: ENTER },
    { waitFor: 'Git author name:', input: GIT_NAME },
    { waitFor: `${GIT_NAME}│`, input: ENTER },
    { waitFor: 'Git author email:', input: GIT_EMAIL },
    { waitFor: `${GIT_EMAIL}│`, input: ENTER },
    { waitFor: '› Use this identity', input: ENTER },
    { waitFor: 'Configure Claude marketplaces or plugins', input: 'n' },
    { waitFor: 'Configure Codex marketplaces or plugins', input: 'n' },
    {
      waitFor: 'expose authenticated T3 Code at its provider URL?',
      input: 'y',
    },
  ];
}

describe('live workstation lifecycle', () => {
  it.concurrent(
    'should create non-interactively and pass every workstation command',
    async ({ expect, signal, annotate }) => {
      const name = harness.workstationName('b');

      await harness.withWorkstation(name, async () => {
        const create = successData(
          await cli.json(
            [
              'create',
              '--name',
              name,
              '--no-git-identity',
              '--update-due-days',
              String(UPDATE_DUE_DAYS),
              // the shortest hold maximum, so a managed hold is refreshed
              // within one update
              '--hold-max-minutes',
              '1',
              // the lifecycle runs on a private network, so every command is
              // proven against an enrolled device
              '--network',
              'tailscale',
              ...provider.createArgs,
            ],
            CREATE_TIMEOUT_MS,
            signal,
          ),
          'create',
        );
        const { id } = create.machine;
        expect(create).toMatchObject({
          profile: { network: 'tailscale' },
          machine: { name, setup: 'ready' },
          readiness: { ready: true, failures: [] },
          pairing: { status: 'not requested' },
        });
        // Git, jj and gh are Homebrew's bottles at the default prefix, linked where every
        // caller finds it; the agent runs it but can change nothing under the
        // prefix, and open-agent installed no compiler, from apt or Homebrew
        const createLog = await readInstallLog(provider, name);
        const homebrewGit = await readHomebrewGit(provider, name);

        await annotate(
          `Git ${homebrewGit.kegVersion} from Homebrew: create's tool steps took ${brewToolDurations(createLog)}; compilers the provider's image ships: ${homebrewGit.imageCompilers.join(', ') || 'none'}`,
        );
        expect(homebrewGit).toEqual({
          agentVersion: homebrewGit.kegVersion,
          agentGit: '/usr/local/bin/git',
          kegVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
          links: Object.fromEntries(
            BREW_TOOLS.map((tool) => [
              tool,
              expect.stringMatching(
                new RegExp(
                  `^${HOMEBREW.prefix.replaceAll('.', '\\.')}/Cellar/${tool}/`,
                ),
              ),
            ]),
          ),
          agentWritable: [],
          owners: [
            `${HOMEBREW.account} ${HOMEBREW.account} 755 ${HOMEBREW.home}`,
            `${HOMEBREW.account} ${HOMEBREW.account} 755 ${HOMEBREW.prefix}`,
            expect.stringMatching(
              new RegExp(`^${HOMEBREW.account} ${HOMEBREW.account} 7[57]5 `),
            ),
          ],
          brewCompilers: [],
          aptCompilers: [],
          imageCompilers: expect.any(Array),
        });
        for (const tool of BREW_TOOLS) {
          expect(componentDuration(createLog, tool)).toEqual(
            expect.any(Number),
          );
        }
        expect(createLog).not.toContainEqual(
          expect.stringMatching(/kernel\.org|\/usr\/bin\/make/),
        );

        await expect
          .poll(async () => (await cleanup.devicesOf(name)).length, {
            timeout: DEVICE_TIMEOUT_MS,
            interval: DEVICE_POLL_MS,
          })
          .toBe(1);

        const setup = successData(
          await cli.json(
            ['setup', name, '--section', 'agent', '--yes'],
            COMMAND_TIMEOUT_MS,
            signal,
          ),
          'setup',
        );

        expect(setup).toMatchObject({
          section: 'agent',
          service: 'configured',
          machine: { name, id },
        });

        const list = successData(
          await cli.json(['list'], READ_TIMEOUT_MS, signal),
          'list',
        );

        expect(list.machines).toContainEqual(
          expect.objectContaining({ name, id, setup: 'ready' }),
        );

        const show = successData(
          await cli.json(['show', name], READ_TIMEOUT_MS, signal),
          'show',
        );

        expect(show).toEqual({
          machine: expect.objectContaining({
            name,
            id,
            setup: 'ready',
            readiness: 'not inspected',
          }),
        });

        // the agent account reports activity as a harness hook does, through
        // the root-owned command, and the governor records each event
        const awakeInstall = await readAwakeInstall(provider, name);
        const awakeSteps = await sendAwakeEvents(provider, name, name);

        expect(awakeInstall).toEqual({
          command: 'root 755',
          directory: 'root agent 2770',
          managedDirectory: 'root agent 2750',
        });
        expect(awakeSteps).toEqual([
          {
            exitCode: 0,
            state: expect.objectContaining({
              lastHeartbeat: expect.any(String),
              openHolds: 0,
              holds: [],
              sleepPermitted: false,
            }),
          },
          {
            exitCode: 0,
            state: expect.objectContaining({
              openHolds: 1,
              holds: [expect.objectContaining({ source: 'live' })],
              sleepPermitted: false,
            }),
          },
          {
            exitCode: 0,
            state: expect.objectContaining({ openHolds: 0, holds: [] }),
          },
        ]);

        // a hold root opens for a managed operation is beyond the agent
        // account's reach: it can neither remove it nor end it early
        const managedHold = await checkManagedHold(provider, name, name);

        expect(managedHold).toEqual({
          removeExitCode: 1,
          managedHolders: 1,
          state: expect.objectContaining({
            openHolds: 1,
            holds: [expect.objectContaining({ source: 'live-root' })],
          }),
        });

        // both harnesses carry the exact awake commands in their hook files
        const hooks = await readAwakeHooks(provider, name);
        const awake = (harness: string, action: string, budget: number) => [
          `${AWAKE_COMMAND} ${action} --source ${harness} --session - --budget-ms ${budget}`,
        ];
        const turnHooks = (harness: string): Record<string, string[]> => ({
          UserPromptSubmit: awake(harness, 'hold-open', 8_000),
          PreToolUse: awake(harness, 'heartbeat', 8_000),
          Stop: awake(harness, 'hold-close', 8_000),
        });

        expect(hooks.claude).toMatchObject({
          ...turnHooks('claude'),
          SessionEnd: awake('claude', 'hold-close', 8_000),
        });
        // Codex waits at most 3 s on SessionEnd and Interrupt hooks
        expect(hooks.codex).toMatchObject({
          ...turnHooks('codex'),
          SessionEnd: awake('codex', 'hold-close', 2_000),
          Interrupt: awake('codex', 'hold-close', 2_000),
        });

        // a hook event arrives as JSON on standard input; the Sprite's own
        // task follows the governor's deadline, and the agent account reaches
        // the task API without a credential
        const hookSteps = await sendHookEvents(provider, name, {
          harness: 'claude',
          session: name,
          actions: ['hold-open', 'heartbeat', 'hold-close'],
          // longer than the expiry tolerance, so a heartbeat that moved
          // nothing could not pass for one that did
          pausesMs: { heartbeat: TASK_EXPIRY_TOLERANCE_MS + 1_000 },
        });
        const [opened, refreshed, closed] = hookSteps;

        expect(
          hookSteps.map(({ action, exitCode, openHolds }) => ({
            action,
            exitCode,
            openHolds,
          })),
        ).toEqual([
          { action: 'hold-open', exitCode: 0, openHolds: 1 },
          { action: 'heartbeat', exitCode: 0, openHolds: 1 },
          { action: 'hold-close', exitCode: 0, openHolds: 0 },
        ]);
        expect(
          hookSteps.every(
            ({ taskExpiresAt, deadline }) =>
              Math.abs(
                Date.parse(taskExpiresAt ?? '') - Date.parse(deadline ?? ''),
              ) <= TASK_EXPIRY_TOLERANCE_MS,
          ),
        ).toBe(true);
        // a heartbeat sent after more than the tolerance moves the deadline and
        // the task's expiry strictly later, and closing the last hold leaves
        // the task at the last heartbeat plus the idle timeout
        expect(Date.parse(refreshed!.deadline ?? '')).toBeGreaterThan(
          Date.parse(opened!.deadline ?? ''),
        );
        expect(Date.parse(refreshed!.taskExpiresAt ?? '')).toBeGreaterThan(
          Date.parse(opened!.taskExpiresAt ?? ''),
        );
        expect(
          Date.parse(closed!.deadline ?? '') -
            Date.parse(closed!.lastHeartbeat ?? ''),
        ).toBe(closed!.idleTimeoutMinutes * MINUTE_MS);

        // a descriptor root holds open (a transaction's lock) never reaches
        // the agent-account child that applies the deadline
        expect(await checkLockDescriptorInheritance(provider, name)).toMatch(
          /^uid=[1-9]\d* lock-fds=0$/,
        );

        // a managed operation longer than half the 1 minute hold maximum has
        // its hold refreshed, so it never lapses mid-operation, and it ends
        // the hold when it finishes
        const refreshWatch = await watchHolders(provider, name, async () =>
          runRefreshProbe(provider, name, REFRESH_PROBE_MS),
        );

        expect(
          refreshWatch.expiries[REFRESH_PROBE_SOURCE],
        ).toBeGreaterThanOrEqual(2);
        expect(refreshWatch.openHoldsAfter).toBe(0);

        const inspected = successData(
          await cli.json(
            ['show', name, '--inspect'],
            COMMAND_TIMEOUT_MS,
            signal,
          ),
          'show',
        );

        expect(inspected).toMatchObject({
          machine: { name, id },
          inspection: {
            manifest: { profile: create.profile },
            readiness: { ready: true },
            native: {
              claude: { awakeHooksInstalled: true },
              codex: { awakeHooksInstalled: true },
            },
            governor: {
              recorded: true,
              state: {
                lastHeartbeat: expect.any(String),
                openHolds: 0,
                holds: [],
              },
            },
          },
        });

        expect(
          foreignIdentifiers(await provider.inspectIdentity(name)),
        ).toEqual([]);

        // the updater installs in place: the agent and the network daemon keep
        // their process through a forced run
        const before = await provider.snapshotServices(name);
        const watched = [t3Service.name, tailscaleDaemon.name];

        expect(before.map((service) => service.name)).toEqual(
          expect.arrayContaining(watched),
        );
        expect(
          before.filter((service) => watched.includes(service.name)),
        ).toEqual(
          watched.map((service) =>
            expect.objectContaining({
              name: service,
              status: 'running',
              pid: expect.any(Number),
              startedAt: expect.any(String),
            }),
          ),
        );

        // a harness genuinely out of date: its previous release, installed by
        // its owning account through the guest's own npm, with a session of it
        // running through the update as an ACP agent session would
        expect(create.profile.harnesses).toContain(codexTool.name);

        const release = await installOlderRelease(provider, name, codexTool);
        const session = await startHarnessSession(provider, name);

        expect(await readLoginVersion(provider, name, codexTool.name)).toBe(
          release.older,
        );

        // an update that skips unchanged components must still reinstall one
        // that is out of date, so make one stale before forcing the update
        await makeComponentStale(provider, name);
        const manifestBefore = await readManifestState(provider, name);

        expect(manifestBefore.installedVersions[STALE_COMPONENT]).toBe(
          STALE_VERSION,
        );

        const firstStartedAt = performance.now();
        // the host transaction and the updater keep the workstation awake as
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
        const manifestAfter = await readManifestState(provider, name);

        expect(update).toMatchObject({
          section: 'tools',
          tools: 'updated',
          components: { installed: expect.any(Number) },
          machine: { name, id },
        });
        expect(holdWatch.sources).toEqual(
          expect.arrayContaining(['transaction', 'updater']),
        );
        expect(holdWatch.openHoldsAfter).toBe(0);
        expect(await provider.snapshotServices(name)).toEqual(before);
        expect(manifestAfter.lastUpdateStatus).toBe('succeeded');
        expect(
          Date.parse(manifestAfter.lastSuccessfulUpdate ?? ''),
        ).toBeGreaterThan(
          Date.parse(manifestBefore.lastSuccessfulUpdate ?? '') || 0,
        );
        // the stale component was reinstalled, not just re-recorded
        expect(manifestAfter.installedVersions[STALE_COMPONENT]).not.toBe(
          STALE_VERSION,
        );
        // the outcome names the stable release; the manifest keeps the raw
        // report, which may carry a build suffix
        expect(manifestAfter.componentOutcomes[STALE_COMPONENT]).toEqual({
          status: 'installed',
          version: expect.any(String),
        });
        expect(manifestAfter.installedVersions[STALE_COMPONENT]).toContain(
          manifestAfter.componentOutcomes[STALE_COMPONENT]?.version,
        );
        expect(
          Object.entries(manifestAfter.componentOutcomes).filter(
            ([, { status }]) => status === 'failed',
          ),
        ).toEqual([]);
        expect(await probeStaleComponent(provider, name)).toBe(
          manifestAfter.installedVersions[STALE_COMPONENT],
        );

        // the older harness was upgraded in place: a new session starts the
        // new release, while the running session keeps every process and the
        // files it started from
        const upgraded = manifestAfter.componentOutcomes[codexTool.name];
        const upgradedVersion = versionOf(upgraded);

        await annotate(
          `${codexTool.name} ${release.older} upgraded to ${upgradedVersion} (latest ${release.latest} before the update) with session processes ${session.map(({ pid }) => pid).join(', ')} running`,
        );
        expect(upgraded).toEqual({
          status: 'installed',
          version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        });
        expect(upgradedVersion).not.toBe(release.older);
        expect(await readLoginVersion(provider, name, codexTool.name)).toBe(
          upgradedVersion,
        );
        expect(await readHarnessSession(provider, name)).toEqual(
          replacedSession(session, (pattern) => expect.stringMatching(pattern)),
        );

        // nothing changed upstream since that update, so an immediate second
        // forced update finds every component current and installs nothing
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
        const manifestRepeated = await readManifestState(provider, name);
        const repeatedLog = await readInstallLog(provider, name);
        const probed = expectedComponents(create.profile);
        const expected = expectedOutcomes(create.profile);
        const recorded = Object.keys(manifestRepeated.componentOutcomes).sort();

        // the outcomes name every component the manifest records and every
        // one the profile installs, so a component cannot be skipped unseen
        expect(recorded).toEqual(expected);
        expect(Object.keys(manifestRepeated.installedVersions).sort()).toEqual(
          probed,
        );
        expect(repeated).toMatchObject({
          section: 'tools',
          tools: 'updated',
          components: { installed: 0, skipped: expected.length },
          machine: { name, id },
        });
        expect(
          Object.fromEntries(
            Object.entries(manifestRepeated.componentOutcomes).map(
              ([component, { status }]) => [component, status],
            ),
          ),
        ).toEqual(
          Object.fromEntries(
            expected.map((component) => [component, 'skipped']),
          ),
        );
        // independent evidence that nothing changed: the Node link, the tools
        // directory, the system links and the npm manifests are the very same
        // files, and the run's own log shows nothing was installed
        expect(await readToolState(provider, name)).toEqual(toolsAfterFirst);
        expect(installActivity(repeatedLog)).toEqual([]);
        expect(skippedComponents(repeatedLog).sort()).toEqual(
          expected.filter((component) => component !== 'node'),
        );
        expect(skippedComponents(repeatedLog)).toContain('git');
        expect(repeatedLog).toContainEqual(
          expect.stringMatching(/^Node v\d+\.\d+\.\d+ is already installed$/),
        );
        expect(manifestRepeated.lastUpdateStatus).toBe('succeeded');
        expect(
          Date.parse(manifestRepeated.lastSuccessfulUpdate ?? ''),
        ).toBeGreaterThan(Date.parse(manifestAfter.lastSuccessfulUpdate ?? ''));
        expect(manifestRepeated.installedVersions).toEqual(
          manifestAfter.installedVersions,
        );
        expect(await provider.snapshotServices(name)).toEqual(before);
        expect(await readHarnessSession(provider, name)).toEqual(
          replacedSession(session, (pattern) => expect.stringMatching(pattern)),
        );
        // root runs everything under the guest root, so it must be root's alone
        expect(exposedEntries(await guestEntries(provider, name))).toEqual([]);

        // a guest whose Node is older than the latest release swaps in the new
        // tree beside the old one, without touching a tree a service runs from
        const { older, live } = await placeOlderNode(provider, name);

        expect((await readNodeTrees(provider, name)).link).toBe(older);

        const swapStartedAt = performance.now();
        const swapped = successData(
          await cli.json(
            ['setup', name, '--section', 'tools', '--update'],
            COMMAND_TIMEOUT_MS,
            signal,
          ),
          'setup',
        );
        const swapMs = Math.round(performance.now() - swapStartedAt);
        const manifestSwapped = await readManifestState(provider, name);
        const nodeTrees = await readNodeTrees(provider, name);
        const latest = manifestSwapped.componentOutcomes.node?.version ?? '';

        await annotate(
          `forced update: first ${firstMs} ms (reinstalled ${STALE_COMPONENT}), repeated ${secondMs} ms (all skipped; checked through brew in ${brewToolDurations(repeatedLog)}), Node swap ${swapMs} ms (Node ${latest} beside the older tree)`,
        );
        expect(swapped).toMatchObject({
          section: 'tools',
          tools: 'updated',
          components: { installed: 1, skipped: expected.length - 1 },
          machine: { name, id },
        });
        expect(manifestSwapped.componentOutcomes.node).toEqual({
          status: 'installed',
          version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        });
        expect(
          Object.entries(manifestSwapped.componentOutcomes).filter(
            ([component, { status }]) =>
              component !== 'node' && status !== 'skipped',
          ),
        ).toEqual([]);
        // the link names a new tree of the latest release, the tree it
        // replaced stays, and the tree a running process uses survives
        expect(nodeTrees.link).toMatch(
          new RegExp(
            `^node-v${latest.replaceAll('.', '\\.')}\\.[A-Za-z0-9]{6}$`,
          ),
        );
        expect([older, live]).not.toContain(nodeTrees.link);
        expect(nodeTrees.trees).toEqual(
          expect.arrayContaining([older, live, nodeTrees.link]),
        );
        expect(manifestSwapped.installedVersions.node).toBe(`v${latest}`);
        expect(manifestSwapped.lastUpdateStatus).toBe('succeeded');
        expect(await provider.snapshotServices(name)).toEqual(before);
        expect(await readHarnessSession(provider, name)).toEqual(
          replacedSession(session, (pattern) => expect.stringMatching(pattern)),
        );
        // the sweep now covers the link, every tree, the tools and the outcomes
        expect(exposedEntries(await guestEntries(provider, name))).toEqual([]);

        // the due interval the create recorded drives the guest: the stored
        // profile holds it, and the scheduled entry, run without --force,
        // updates only once the due days have passed
        expect(create.profile.options).toMatchObject({
          updateDueIntervalDays: UPDATE_DUE_DAYS,
        });
        expect(await readStoredIntervals(provider, name)).toEqual({
          updateDueIntervalDays: UPDATE_DUE_DAYS,
        });

        const scheduledStartedAt = Date.now();
        const recent = new Date(scheduledStartedAt - 2 * DAY_MS);
        await setLastSuccessfulUpdate(provider, name, recent);
        const attemptBeforeSkip = (await readManifestState(provider, name))
          .lastAttemptedUpdate;
        const skippedRun = await runScheduledEntry(provider, name);
        const manifestSkipped = await readManifestState(provider, name);

        // the updater ran and found the update not due: it ended cleanly and
        // attempted nothing
        expectCompletedRun(expect, skippedRun);
        expect(manifestSkipped.lastSuccessfulUpdate).toBe(recent.toISOString());
        expect(manifestSkipped.lastAttemptedUpdate).toBe(attemptBeforeSkip);
        expect(manifestSkipped.lastUpdateDiagnostic).toBeUndefined();

        await setLastSuccessfulUpdate(
          provider,
          name,
          new Date(scheduledStartedAt - 4 * DAY_MS),
        );
        const dueRun = await runScheduledEntry(provider, name);
        const manifestDue = await readManifestState(provider, name);

        expectCompletedRun(expect, dueRun);
        expect({
          status: manifestDue.lastUpdateStatus,
          error: manifestDue.lastUpdateError,
        }).toEqual({ status: 'succeeded', error: undefined });
        expect(
          Date.parse(manifestDue.lastSuccessfulUpdate ?? ''),
        ).toBeGreaterThanOrEqual(scheduledStartedAt);
        expect(
          Date.parse(manifestDue.lastAttemptedUpdate ?? ''),
        ).toBeGreaterThanOrEqual(scheduledStartedAt);
        expect(manifestDue.lastAttemptedUpdate).not.toBe(attemptBeforeSkip);
        expect(await provider.snapshotServices(name)).toEqual(before);

        // a later setup changes the due interval, and starts, stops and
        // restarts nothing
        const rescheduled = successData(
          await cli.json(
            [
              'setup',
              name,
              '--section',
              'tools',
              '--update-due-days',
              String(RESCHEDULED_DUE_DAYS),
            ],
            COMMAND_TIMEOUT_MS,
            signal,
          ),
          'setup',
        );

        expect(rescheduled).toMatchObject({
          section: 'tools',
          tools: 'scheduled',
          machine: { name, id },
        });
        expect(await readStoredIntervals(provider, name)).toEqual({
          updateDueIntervalDays: RESCHEDULED_DUE_DAYS,
        });
        expect(await provider.snapshotServices(name)).toEqual(before);

        // four days is now below the due interval, so the same entry skips
        const stale = new Date(Date.now() - 4 * DAY_MS);
        await setLastSuccessfulUpdate(provider, name, stale);
        const attemptBeforeStale = (await readManifestState(provider, name))
          .lastAttemptedUpdate;
        const staleRun = await runScheduledEntry(provider, name);
        const manifestStale = await readManifestState(provider, name);

        expectCompletedRun(expect, staleRun);
        expect(manifestStale.lastSuccessfulUpdate).toBe(stale.toISOString());
        expect(manifestStale.lastAttemptedUpdate).toBe(attemptBeforeStale);
        expect(manifestStale.lastUpdateDiagnostic).toBeUndefined();
        // the cron entry and the lock the runs used are root-only
        expect(exposedEntries(await guestEntries(provider, name))).toEqual([]);
        expect(await provider.snapshotServices(name)).toEqual(before);

        const doctor = successData(
          await cli.json(['doctor', name], COMMAND_TIMEOUT_MS, signal),
          'doctor',
        );

        expect(doctor).toMatchObject({
          machine: { name, id },
          currentReadiness: { ready: true, failures: [] },
        });

        const terminate = successData(
          await cli.json(
            ['terminate', name, '--yes'],
            COMMAND_TIMEOUT_MS,
            signal,
          ),
          'terminate',
        );

        expect(terminate).toMatchObject({
          workstation: { status: 'deleted', id, name },
          network: {
            status: 'deleted',
          },
        });

        await cleanup.proveAbsent(name);
      });
    },
  );

  it.concurrent(
    'should keep a Sprite awake through a harness turn, then let it sleep and wake on a URL request',
    async ({ expect, signal, annotate }) => {
      const missing = PROXY_REQUIRED.filter((key) => !harness.hasValue(key));
      if (missing.length > 0) {
        throw new Error(
          `A real harness turn routes through CLIProxyAPI and needs ${missing.join(', ')} set`,
        );
      }
      const name = harness.workstationName('w');

      await harness.withWorkstation(name, async () => {
        const create = successData(
          await cli.json(
            [
              'create',
              '--name',
              name,
              '--no-git-identity',
              '--idle-minutes',
              String(IDLE_MINUTES),
              '--proxy',
              ...provider.createArgs,
            ],
            CREATE_TIMEOUT_MS,
            signal,
          ),
          'create',
        );
        const { holdMaxMinutes } = create.profile.options;
        const idleMs = IDLE_MINUTES * MINUTE_MS;
        const turn = { tag: 'long', sleepSeconds: LONG_TURN_SECONDS };

        expect(create.profile.options).toMatchObject({
          isProxyEnabled: true,
          idleTimeoutMinutes: IDLE_MINUTES,
        });

        // a real turn whose tool call outlasts the idle timeout: its hold,
        // not the idle timeout, sets the deadline, and the Sprite task tracks it
        await startTickLog(provider, name);
        await startHarnessTurn(provider, name, turn);
        await waitForToolCall(provider, name, turn);
        const during = await readGovernor(provider, name);
        const taskDuring = await readAwakeTaskExpiry(provider, name);
        const heldMs = instant(during.deadline) - instant(during.lastHeartbeat);

        expect(during).toMatchObject({
          idleTimeoutMinutes: IDLE_MINUTES,
          openHolds: 1,
          holds: [{ source: 'claude', expiresAt: during.deadline }],
        });
        expect(heldMs).toBeGreaterThan(idleMs);
        expect(heldMs).toBeLessThanOrEqual(holdMaxMinutes * MINUTE_MS);
        expect(
          Math.abs(instant(taskDuring) - instant(during.deadline)),
        ).toBeLessThanOrEqual(TASK_EXPIRY_TOLERANCE_MS);

        // nothing touches the guest for longer than the idle timeout, so only
        // the turn keeps the Sprite running
        const quiet = await watchRunStates(provider, name, {
          durationMs: LONG_QUIET_MS,
        });

        expect(quiet.length).toBeGreaterThan(0);
        expect(quiet.filter(({ status }) => status !== 'running')).toEqual([]);

        const outcome = await waitForTurnEnd(provider, name, turn);
        const after = await readGovernor(provider, name);
        // the turn-end hook records the last heartbeat and the harness exits
        // after it; a pause's last tick lands up to a second before it begins
        const turnPauses = (
          await readPauses(provider, name, outcome.startedAt)
        ).filter(
          ({ from }) =>
            Date.parse(from) + PAUSE_ROUNDING_MS < instant(after.lastHeartbeat),
        );

        expect(outcome).toMatchObject({
          exitCode: 0,
          reply: expect.stringMatching(/done/i),
        });
        expect(
          Date.parse(outcome.endedAt) - Date.parse(outcome.startedAt),
        ).toBeGreaterThan(LONG_TURN_SECONDS * SECOND_MS);
        // the guest's own clock ran without a gap through the whole turn
        expect(turnPauses).toEqual([]);
        // turn end closed the hold; only the idle timeout remains
        expect(after).toMatchObject({ openHolds: 0, holds: [] });
        expect(instant(after.deadline) - instant(after.lastHeartbeat)).toBe(
          idleMs,
        );

        // with no turn and nothing touching the guest, the Sprite sleeps once
        // the idle timeout has passed, and not before; the provider's own
        // record is read when it carries transition times
        const settling = await watchRunStates(provider, name, {
          durationMs: instant(after.deadline) - Date.now() + SLEEP_GRACE_MS,
          until: isAsleep,
          settleMs: OBSERVED_SLEEP_MS,
        });
        const asleep = settling.findLast(isAsleep);

        expect(
          settling.filter(
            ({ at, status }) =>
              Date.parse(at) < instant(after.deadline) && status !== 'running',
          ),
        ).toEqual([]);

        // a request to the public URL wakes the Sprite and the ACP agent answers
        const url = await provider.readUrl(name);
        const requestedAt = Date.now();
        const page = await fetch(url, { signal });
        const environment = await fetch(
          new URL('/.well-known/t3/environment', url),
          { signal },
        );
        const respondedAt = Date.now();

        expect({
          status: page.status,
          type: page.headers.get('content-type'),
        }).toEqual({ status: 200, type: expect.stringContaining('text/html') });
        expect(environment.status).toBe(200);
        expect(await environment.json()).toEqual(
          expect.objectContaining({ environmentId: expect.any(String) }),
        );

        // the Sprite may serve the request and sleep again at once, so its
        // last transition to running is the provider's evidence
        const woken = (
          await watchRunStates(provider, name, {
            durationMs: READ_TIMEOUT_MS,
            until: ({ lastRunningAt }) =>
              instant(lastRunningAt) >= requestedAt - TRANSITION_ROUNDING_MS,
          })
        ).at(-1);
        // the guest's own clock is the authoritative evidence: it stopped once
        // the deadline passed and ran again only for the request
        const [sleep] = await readPauses(provider, name, outcome.endedAt);

        await annotate(
          `deadline ${String(after.deadline)}: the guest stopped after its tick at ${String(sleep?.from)} (${instant(sleep?.from) - instant(after.deadline)} ms after the deadline) and ran again at ${String(sleep?.to)}; the provider recorded sleep at ${String(asleep?.lastWarmingAt)} (${instant(asleep?.lastWarmingAt) - instant(after.deadline)} ms, whole seconds)`,
        );
        await annotate(
          `the URL request at ${new Date(requestedAt).toISOString()} was answered by ${new Date(respondedAt).toISOString()}; the provider then recorded running from ${String(woken?.lastRunningAt)}, now ${String(woken?.status)}`,
        );
        expect(instant(sleep?.from)).toBeGreaterThanOrEqual(
          instant(after.deadline) - PAUSE_ROUNDING_MS,
        );
        expect(instant(sleep?.from)).toBeLessThanOrEqual(
          instant(after.deadline) + SLEEP_GRACE_MS,
        );
        // the guest and host clocks agree to well under a second
        expect(instant(sleep?.to)).toBeGreaterThanOrEqual(
          requestedAt - TRANSITION_ROUNDING_MS,
        );
        expect(instant(sleep?.to)).toBeLessThanOrEqual(
          respondedAt + TRANSITION_ROUNDING_MS,
        );
        // the request reached the agent, not a harness: the governor saw nothing
        expect(await readGovernor(provider, name)).toEqual(after);

        // an open ACP connection without harness activity adds no heartbeat,
        // no hold and no Sprite task
        const connection = await openAgentConnection(provider, name, url);
        const openedAt = Date.now();
        const connected = await watchRunStates(provider, name, {
          durationMs: idleMs + MINUTE_MS,
        });
        const heldOpen = connection.isOpen();
        const connectedPauses = (
          await readPauses(provider, name, new Date(openedAt).toISOString())
        ).filter(({ from }) => Date.parse(from) < Date.now());
        const governed = await readGovernor(provider, name);
        const taskConnected = await readAwakeTaskExpiry(provider, name);
        await connection.close();
        const closedAt = Date.now();
        const released = await watchRunStates(provider, name, {
          durationMs: SLEEP_GRACE_MS,
          until: isAsleep,
          settleMs: OBSERVED_SLEEP_MS,
        });
        const [releasedSleep] = await readPauses(
          provider,
          name,
          new Date(closedAt).toISOString(),
        );

        await annotate(
          `while the ACP connection stayed open for ${closedAt - openedAt} ms the provider reported ${describeSamples(connected)} and the guest paused ${JSON.stringify(connectedPauses)}; after it closed the guest stopped after its tick at ${String(releasedSleep?.from)} (${instant(releasedSleep?.from) - closedAt} ms later) and the provider recorded sleep at ${String(released.findLast(isAsleep)?.lastWarmingAt)}`,
        );
        expect(heldOpen).toBe(true);
        expect(governed).toEqual(after);
        expect(taskConnected).toBeUndefined();
        expect(instant(releasedSleep?.from)).toBeLessThanOrEqual(
          closedAt + SLEEP_GRACE_MS,
        );
      });
    },
  );

  it.concurrent(
    'should delete the Sprite task when the last hold closes and the idle timeout is 0',
    async ({ expect, signal, annotate }) => {
      const name = harness.workstationName('z');

      await harness.withWorkstation(name, async () => {
        successData(
          await cli.json(
            [
              'create',
              '--name',
              name,
              '--no-git-identity',
              '--idle-minutes',
              '0',
              '--hold-max-minutes',
              String(SHORT_HOLD_MAX_MINUTES),
              '--proxy',
              ...provider.createArgs,
            ],
            CREATE_TIMEOUT_MS,
            signal,
          ),
          'create',
        );

        const steps = await sendHookEvents(provider, name, {
          harness: 'codex',
          session: name,
          actions: ['hold-open', 'hold-close'],
        });

        expect(steps).toEqual([
          expect.objectContaining({
            action: 'hold-open',
            exitCode: 0,
            openHolds: 1,
            deadline: expect.any(String),
            taskExpiresAt: expect.any(String),
          }),
          expect.objectContaining({
            action: 'hold-close',
            exitCode: 0,
            openHolds: 0,
            deadline: undefined,
            taskExpiresAt: undefined,
          }),
        ]);
        expect(
          Math.abs(
            instant(steps[0]!.taskExpiresAt) - instant(steps[0]!.deadline),
          ),
        ).toBeLessThanOrEqual(TASK_EXPIRY_TOLERANCE_MS);

        // a real turn still keeps the Sprite awake with an idle timeout of 0
        const turn = { tag: 'held', sleepSeconds: SHORT_TURN_SECONDS };

        await startTickLog(provider, name);
        await startAwakeLog(provider, name);
        await startHarnessTurn(provider, name, turn);
        await waitForToolCall(provider, name, turn);
        const during = await readGovernor(provider, name);
        const taskDuring = await readAwakeTaskExpiry(provider, name);

        expect(during).toMatchObject({
          idleTimeoutMinutes: 0,
          openHolds: 1,
          holds: [{ source: 'claude', expiresAt: during.deadline }],
        });
        expect(
          Math.abs(instant(taskDuring) - instant(during.deadline)),
        ).toBeLessThanOrEqual(TASK_EXPIRY_TOLERANCE_MS);

        const quiet = await watchRunStates(provider, name, {
          durationMs: SHORT_QUIET_MS,
        });

        expect(quiet.length).toBeGreaterThan(0);
        expect(quiet.filter(({ status }) => status !== 'running')).toEqual([]);

        // no keep-awake task outlives the turn, and the Sprite then sleeps
        const outcome = await waitForTurnEnd(provider, name, turn);
        const after = await readGovernor(provider, name);
        // the turn-end hook records the last heartbeat and the harness exits
        // after it; a pause's last tick lands up to a second before it begins
        const turnPauses = (
          await readPauses(provider, name, outcome.startedAt)
        ).filter(
          ({ from }) =>
            Date.parse(from) + PAUSE_ROUNDING_MS < instant(after.lastHeartbeat),
        );
        const taskAfter = await readAwakeTaskExpiry(provider, name);
        // whether the Sprite held the awake task at every second of the turn,
        // and what it and the governor recorded around any pause in it
        const samples = await stopAwakeLog(provider, name, {
          from: outcome.startedAt,
          to: new Date().toISOString(),
        });
        const turnSamples = samples.filter(
          ({ at }) => Date.parse(at) <= instant(after.lastHeartbeat),
        );
        const taskless = turnSamples.filter(
          ({ taskExpiresAt }) => taskExpiresAt === undefined,
        );

        await annotate(
          `idle 0 awake task: present in ${turnSamples.length - taskless.length} of ${turnSamples.length} samples from the turn's start at ${outcome.startedAt} to the turn-end hook; missing at ${taskless.map(({ at }) => at).join(', ') || 'no sample'}; during the tool call the governor's deadline was ${String(during.deadline)} and the task expired at ${String(taskDuring)}; after the turn the task expired at ${String(taskAfter)}`,
        );
        for (const pause of turnPauses) {
          await annotate(
            `idle 0 pause ${JSON.stringify(pause)} during the turn; samples around it: ${JSON.stringify(
              samples.filter(
                ({ at }) =>
                  Date.parse(at) >= Date.parse(pause.from) - PAUSE_CONTEXT_MS &&
                  Date.parse(at) <= Date.parse(pause.to) + PAUSE_CONTEXT_MS,
              ),
            )}`,
          );
        }
        const lastReadAt = Date.now();
        const settled = (
          await watchRunStates(provider, name, {
            durationMs: SLEEP_GRACE_MS,
            until: isAsleep,
            settleMs: OBSERVED_SLEEP_MS,
          })
        ).findLast(isAsleep);
        const [idleSleep] = await readPauses(
          provider,
          name,
          new Date(lastReadAt - PAUSE_ROUNDING_MS).toISOString(),
        );

        await annotate(
          `idle 0: the turn-end hook ran at ${String(after.lastHeartbeat)}; after the last guest read the guest stopped after its tick at ${String(idleSleep?.from)} (${instant(idleSleep?.from) - lastReadAt} ms later) and the provider recorded sleep at ${String(settled?.lastWarmingAt)}`,
        );
        expect(outcome).toMatchObject({ exitCode: 0 });
        expect(turnPauses).toEqual([]);
        expect(after).toMatchObject({
          openHolds: 0,
          holds: [],
          deadline: undefined,
        });
        expect(taskAfter).toBeUndefined();
        expect(instant(idleSleep?.from)).toBeLessThanOrEqual(
          lastReadAt + SLEEP_GRACE_MS,
        );

        // a turn that crashes before its turn-end hook keeps its hold only
        // until the hold maximum after its last refresh, then the Sprite sleeps
        const crashed = { tag: 'crashed', sleepSeconds: CRASH_TURN_SECONDS };

        await startHarnessTurn(provider, name, crashed);
        await waitForToolCall(provider, name, crashed);
        await crashHarnessTurn(provider, name, crashed);
        const crashOutcome = await waitForTurnEnd(provider, name, crashed);
        const orphaned = await readGovernor(provider, name);
        const taskOrphaned = await readAwakeTaskExpiry(provider, name);
        const [orphanHold] = orphaned.holds;
        const orphanMs =
          instant(orphanHold?.expiresAt) - instant(orphaned.lastHeartbeat);

        expect(crashOutcome.exitCode).toBe(137);
        expect(orphaned).toMatchObject({
          openHolds: 1,
          holds: [{ source: 'claude', expiresAt: orphaned.deadline }],
        });
        expect(orphanMs).toBeLessThanOrEqual(
          SHORT_HOLD_MAX_MINUTES * MINUTE_MS,
        );
        expect(orphanMs).toBeGreaterThan(
          SHORT_HOLD_MAX_MINUTES * MINUTE_MS - HOLD_REFRESH_SKEW_MS,
        );
        expect(
          Math.abs(instant(taskOrphaned) - instant(orphaned.deadline)),
        ).toBeLessThanOrEqual(TASK_EXPIRY_TOLERANCE_MS);

        const orphanedReadAt = Date.now();
        const expiring = await watchRunStates(provider, name, {
          durationMs: instant(orphaned.deadline) - Date.now() + SLEEP_GRACE_MS,
          until: isAsleep,
          settleMs: OBSERVED_SLEEP_MS,
        });
        const [expirySleep] = await readPauses(
          provider,
          name,
          new Date(orphanedReadAt).toISOString(),
        );

        await annotate(
          `crashed turn: the orphaned hold expired ${String(orphaned.deadline)}; the guest stopped after its tick at ${String(expirySleep?.from)} (${instant(expirySleep?.from) - instant(orphaned.deadline)} ms after it) and the provider recorded sleep at ${String(expiring.findLast(isAsleep)?.lastWarmingAt)}`,
        );
        // the orphaned hold alone kept the Sprite running until it expired
        expect(
          expiring.filter(
            ({ at, status }) =>
              Date.parse(at) < instant(orphaned.deadline) &&
              status !== 'running',
          ),
        ).toEqual([]);
        expect(instant(expirySleep?.from)).toBeGreaterThanOrEqual(
          instant(orphaned.deadline) - PAUSE_ROUNDING_MS,
        );
        expect(instant(expirySleep?.from)).toBeLessThanOrEqual(
          instant(orphaned.deadline) + SLEEP_GRACE_MS,
        );
      });
    },
  );

  it.concurrent(
    'should run a workstation with no private network and install no network tool',
    async ({ expect, signal }) => {
      const name = harness.workstationName('n');

      await harness.withWorkstation(name, async () => {
        // the dotenv hub is private to the tailnet, which this workstation does
        // not join, and a harness without a gateway has no model credentials,
        // so T3 reports no ready provider and readiness withholds public
        // exposure; the workstation is retained and everything else is checked
        // on it, with the network proven to take no part in that failure
        const created = await cli.json(
          [
            'create',
            '--name',
            name,
            '--network',
            'none',
            '--no-proxy',
            '--no-git-identity',
            ...provider.createArgs,
          ],
          CREATE_TIMEOUT_MS,
          signal,
        );

        expect(created.envelope.command).toBe('create');
        if (!created.envelope.ok) {
          expect(
            created.envelope.error,
            created.envelope.error?.message,
          ).toMatchObject({
            code: 'PREFLIGHT',
            outcome: 'retained',
            machine: name,
          });
        }
        expect(created.envelope.error?.message ?? '').not.toMatch(
          NETWORK_FAILURE,
        );

        // neither Tailscale program is on the search path or anywhere the
        // installer or a package could have put it, under the guest root
        // included; module folders are directories, so only files and links match
        expect(
          await provider.execute(
            name,
            `command -v tailscale tailscaled; find /opt/open-agent /usr /var/lib /etc \\( -name tailscale -o -name tailscaled \\) \\( -type f -o -type l \\) 2>/dev/null; true`,
          ),
        ).toBe('');
        expect(await cleanup.devicesOf(name)).toEqual([]);

        // no tailscaled service is registered, and the agent service starts
        // after nothing
        const services = await provider.snapshotServices(name);

        expect(services.map(({ name: service }) => service)).not.toContain(
          tailscaleDaemon.name,
        );
        expect(services).toContainEqual(
          expect.objectContaining({
            name: t3Service.name,
            status: 'running',
            needs: [],
          }),
        );
        expect(
          services.filter(({ needs }) => needs.includes(tailscaleDaemon.name)),
        ).toEqual([]);

        // the agent answers on its own port without any network daemon
        expect(
          await provider.execute(
            name,
            `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${String(t3Service.httpPort)}/.well-known/t3/environment`,
          ),
        ).toBe('200');

        const manifest = await readManifestState(provider, name);

        expect(Object.keys(manifest.installedVersions).sort()).toEqual(
          expectedComponents({
            agent: 't3',
            harnesses: ['claude', 'codex'],
            network: 'none',
          }),
        );
        expect(manifest.installedVersions).not.toHaveProperty('tailscale');

        const show = successData(
          await cli.json(
            ['show', name, '--inspect'],
            COMMAND_TIMEOUT_MS,
            signal,
          ),
          'show',
        );

        expect(show).toMatchObject({
          machine: { name },
          inspection: {
            manifest: { profile: { network: 'none' } },
            network: { skipped: true, online: false },
          },
        });
        expect(
          JSON.stringify([
            show.inspection?.network,
            show.inspection?.readiness,
          ]),
        ).not.toMatch(NETWORK_FAILURE);
        expect(
          show.inspection?.readiness?.failures.filter(
            (failure) => !MODEL_ACCESS_FAILURE.test(failure),
          ),
        ).toEqual([]);

        const doctor = await cli.json(
          ['doctor', name],
          COMMAND_TIMEOUT_MS,
          signal,
        );

        expect(doctor.envelope).toMatchObject({
          command: 'doctor',
          data: {
            machine: { name },
            currentReadiness: { network: { skipped: true, online: false } },
          },
        });
        expect(doctor.envelope).toMatchObject({
          data: {
            currentReadiness: {
              failures: expect.not.arrayContaining([
                expect.stringMatching(NETWORK_FAILURE),
              ]),
            },
          },
        });

        const terminate = successData(
          await cli.json(
            ['terminate', name, '--yes'],
            COMMAND_TIMEOUT_MS,
            signal,
          ),
          'terminate',
        );

        expect(terminate).toMatchObject({
          workstation: { status: 'deleted', name },
          network: { status: 'no device identity recorded' },
        });

        await cleanup.proveAbsent(name);
      });
    },
  );

  it.concurrent(
    'should create through every interactive prompt on a native terminal',
    async ({ expect, signal }) => {
      const name = harness.workstationName('i');
      const steps = interactiveCreateSteps(name);
      const mismatched = [
        ...INTERACTIVE_REQUIRED.filter((key) => !harness.hasValue(key)),
        ...INTERACTIVE_UNSET.filter((key) => harness.hasValue(key)),
      ];
      if (mismatched.length > 0) {
        throw new Error(
          `Interactive create answers need ${INTERACTIVE_REQUIRED.join(', ')} set and ` +
            `${INTERACTIVE_UNSET.join(', ')} empty; mismatched: ${mismatched.join(', ')}`,
        );
      }

      await harness.withWorkstation(name, async () => {
        const terminal = await cli.terminal(
          ['create', ...provider.createArgs],
          steps,
          CREATE_TIMEOUT_MS,
        );

        expect(
          {
            exitCode: terminal.exitCode,
            timedOut: terminal.timedOut,
            matchedSteps: terminal.matchedSteps,
          },
          tail(terminal.output),
        ).toEqual({ exitCode: 0, timedOut: false, matchedSteps: steps.length });

        const show = successData(
          await cli.json(
            ['show', name, '--inspect'],
            COMMAND_TIMEOUT_MS,
            signal,
          ),
          'show',
        );

        expect(show).toMatchObject({
          machine: { name, setup: 'ready' },
          inspection: {
            manifest: {
              profile: {
                network: 'tailscale',
                options: { isExitNodeEnabled: false, isProxyEnabled: true },
              },
            },
            readiness: { ready: true },
          },
        });
        expect(
          foreignIdentifiers(await provider.inspectIdentity(name)),
        ).toEqual([]);
        await expect
          .poll(async () => (await cleanup.devicesOf(name)).length, {
            timeout: DEVICE_TIMEOUT_MS,
            interval: DEVICE_POLL_MS,
          })
          .toBe(1);
      });
    },
  );
});
