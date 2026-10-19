import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { AWAKE_COMMAND } from '#adapters/guest/platform/awake';
import { RUNTIME_ENV_PATH } from '#adapters/guest/platform/layout';
import { registry } from '#composition/registry';
import { t3Service } from '#adapters/drivers/agents/t3/service';
import { codexTool } from '#adapters/drivers/harnesses/codex/tools';
import { tailscaleDaemon } from '#adapters/drivers/networks/tailscale/service';

import { successData } from './cli';
import {
  asRoot,
  BREW_TOOLS,
  checkManagedHold,
  exposedEntries,
  guestEntries,
  installOlderRelease,
  loggedOutcomes,
  probeStaleComponent,
  profileTools,
  readAwakeHooks,
  readAwakeInstall,
  readEnvironment,
  readHarnessSession,
  readHomebrewGit,
  readLoginVersion,
  readStoredIntervals,
  readToolState,
  readUpdateLog,
  readUpdateRecord,
  removeToolLink,
  replacedSession,
  runScheduledEntry,
  sendAwakeEvents,
  sendHookEvents,
  setLastSuccessfulUpdate,
  startHarnessSession,
  STALE_COMPONENT,
  updateOutcomes,
  watchHolders,
} from './guest';
import { HOMEBREW } from './layout';
import { foreignIdentifiers } from './ownership';

import type { UpdateToolOutcome } from '#domain/observations/updates';

import type { UpdateRecord } from './guest';
import type { MachineHarness } from './harness';

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
// due intervals the default cannot produce
const UPDATE_DUE_DAYS = 3;
const RESCHEDULED_DUE_DAYS = 5;
const GIT_NAME = 'Open Agent E2E';
const GIT_EMAIL = 'e2e@example.invalid';
// what the runtime env file of the create carries: no credential, no OA_* name
const RUNTIME_PROBE = { E2E_RUNTIME_PROBE: 'forwarded' };
// a real harness turn routes through the profile's CLIProxyAPI hub
const PROXY_REQUIRED = ['CLIPROXYAPI_BASE_URL', 'CLIPROXYAPI_API_KEY'];
// the create that skips GitHub access assumes the run supplies no GitHub token
const GITHUB_UNSET = ['GH_TOKEN', 'GITHUB_TOKEN'];
// the readiness findings a workstation without model credentials fails
const MODEL_ACCESS_FAILURE = /gateway/iu;
// anything that would show the missing network taking part in the result
const NETWORK_FAILURE = /tailscale|tailnet|tailscaled|exit node|\bDNS\b/iu;
const SECOND_MS = 1000;

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
 * registers the scenarios every machine type passes alike, each creating
 * workstations of the harness's type through the packed CLI
 * @param harness the machine type's harness, scoped to this run
 */
export function describeWorkstationSuite(harness: MachineHarness): void {
  const { cleanup, provider } = harness;
  const type = provider.name;
  // a provider with a native deadline mirrors the governor's into its own task
  const hasNativeDeadline =
    registry.providers[type].capabilities.keepAwakeMode === 'native-deadline';

  describe(`${type} workstation lifecycle`, () => {
    it.concurrent(
      'should create non-interactively and pass every workstation command',
      async ({ expect, signal, annotate }) => {
        const name = harness.workstationName('b');
        const cli = await harness.isolatedCli('b');

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
                '--provider',
                type,
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
          // Git, jj and gh are Homebrew's bottles at the default prefix, which
          // the agent's PATH searches first; the agent runs them but can change
          // nothing under the prefix, and Homebrew poured every keg and
          // installed no compiler
          const homebrewGit = await readHomebrewGit(provider, name);

          await annotate(`Git ${homebrewGit.kegVersion} from Homebrew`);
          expect(homebrewGit).toEqual({
            agentVersion: homebrewGit.kegVersion,
            agentGit: `${HOMEBREW.prefix}/bin/git`,
            // the login profile names Homebrew's nano as the agent's editor
            agentEditor: ['nano', 'nano', `${HOMEBREW.prefix}/bin/nano`],
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
            unbottledKegs: [],
          });

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
            directory: 'root agent 1770',
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
                holds: [expect.objectContaining({ source: 'e2e' })],
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
              holds: [expect.objectContaining({ source: 'e2e-root' })],
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
          // a heartbeat sent after more than the tolerance moves the deadline,
          // and the provider's own task with it, strictly later, and closing the
          // last hold leaves the deadline at the last heartbeat plus the idle timeout
          expect(Date.parse(refreshed!.deadline ?? '')).toBeGreaterThan(
            Date.parse(opened!.deadline ?? ''),
          );
          expect(
            hookSteps.map(({ taskExpiresAt, deadline }) =>
              hasNativeDeadline
                ? Math.abs(
                    Date.parse(taskExpiresAt ?? '') -
                      Date.parse(deadline ?? ''),
                  ) <= TASK_EXPIRY_TOLERANCE_MS
                : taskExpiresAt === undefined,
            ),
          ).toEqual([true, true, true]);
          expect(
            Date.parse(refreshed!.taskExpiresAt ?? '') >
              Date.parse(opened!.taskExpiresAt ?? ''),
          ).toBe(hasNativeDeadline);
          expect(
            Date.parse(closed!.deadline ?? '') -
              Date.parse(closed!.lastHeartbeat ?? ''),
          ).toBe(closed!.idleTimeoutMinutes * MINUTE_MS);

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
              environment: { profile: create.profile },
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

          // an update must also repair what is missing, not only upgrade what
          // is there, so remove a tool's link before forcing the update
          await removeToolLink(provider, name);
          const statusBefore = await readUpdateRecord(provider, name);

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
            replacedSession(session, (pattern) =>
              expect.stringMatching(pattern),
            ),
          );

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
          expect(
            statusRepeated.tools.map(({ name: tool, to }) => [tool, to]),
          ).toEqual(statusAfter.tools.map(({ name: tool, to }) => [tool, to]));
          expect(await provider.snapshotServices(name)).toEqual(before);
          expect(await readHarnessSession(provider, name)).toEqual(
            replacedSession(session, (pattern) =>
              expect.stringMatching(pattern),
            ),
          );
          // root runs everything under the guest root, so it must be root's alone
          expect(exposedEntries(await guestEntries(provider, name))).toEqual(
            [],
          );

          // the due interval the create recorded drives the guest: the stored
          // profile and the schedule hold it, and the scheduled entry, run
          // without --force, updates only once the due days have passed
          expect(create.profile.options).toMatchObject({
            updateDueIntervalDays: UPDATE_DUE_DAYS,
          });
          expect(await readStoredIntervals(provider, name)).toEqual({
            updateDueIntervalDays: UPDATE_DUE_DAYS,
            scheduleDueDays: UPDATE_DUE_DAYS,
          });

          const scheduledStartedAt = Date.now();
          // the updater records whole seconds
          const scheduledSecond =
            Math.floor(scheduledStartedAt / SECOND_MS) * SECOND_MS;
          const recent = new Date(scheduledStartedAt - 2 * DAY_MS);
          await setLastSuccessfulUpdate(provider, name, recent);
          const skippedRun = await runScheduledEntry(provider, name);

          // the gate found the update not due: it ended cleanly and ran nothing
          expect(skippedRun).toEqual({ exitStatus: 0, updated: false });
          expect((await readUpdateRecord(provider, name)).lastSuccess).toBe(
            recent.toISOString(),
          );

          await setLastSuccessfulUpdate(
            provider,
            name,
            new Date(scheduledStartedAt - 4 * DAY_MS),
          );
          const dueRun = await runScheduledEntry(provider, name);
          const statusDue = await readUpdateRecord(provider, name);

          expect(dueRun).toEqual({ exitStatus: 0, updated: true });
          expect(statusDue).toMatchObject({
            finishedAt: expect.any(String),
            links: 'restored',
          });
          expect(Date.parse(statusDue.startedAt ?? '')).toBeGreaterThanOrEqual(
            scheduledSecond,
          );
          expect(
            Date.parse(statusDue.lastSuccess ?? ''),
          ).toBeGreaterThanOrEqual(scheduledSecond);
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
            scheduleDueDays: RESCHEDULED_DUE_DAYS,
          });
          expect(await provider.snapshotServices(name)).toEqual(before);

          // four days is now below the due interval, so the same entry skips
          const stale = new Date(Date.now() - 4 * DAY_MS);
          await setLastSuccessfulUpdate(provider, name, stale);
          const staleRun = await runScheduledEntry(provider, name);

          expect(staleRun).toEqual({ exitStatus: 0, updated: false });
          expect((await readUpdateRecord(provider, name)).lastSuccess).toBe(
            stale.toISOString(),
          );
          // the cron entry and the lock the runs used are root-only
          expect(exposedEntries(await guestEntries(provider, name))).toEqual(
            [],
          );
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
      'should run a workstation with no private network and install no network tool',
      async ({ expect, signal }) => {
        const name = harness.workstationName('n');
        const cli = await harness.isolatedCli('n');

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
              '--provider',
              type,
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
            services.filter(({ needs }) =>
              needs.includes(tailscaleDaemon.name),
            ),
          ).toEqual([]);

          // the agent answers on its own port without any network daemon
          expect(
            await provider.execute(
              name,
              `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${String(t3Service.httpPort)}/.well-known/t3/environment`,
            ),
          ).toBe('200');

          const installed = (await readEnvironment(provider, name)).tools.map(
            ({ name: tool }) => tool,
          );

          expect(installed).toEqual(
            expect.arrayContaining(
              profileTools({
                agent: 't3',
                harnesses: ['claude', 'codex'],
                network: 'none',
              }),
            ),
          );
          expect(installed).not.toContain('tailscale');

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
              environment: { profile: { network: 'none' } },
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
      'should create non-interactively with a proxy, a git identity, a runtime env file and no GitHub access or plugins',
      async ({ expect, signal }) => {
        const name = harness.workstationName('i');
        const cli = await harness.isolatedCli('i');
        const mismatched = [
          ...PROXY_REQUIRED.filter((key) => !harness.hasValue(key)),
          ...GITHUB_UNSET.filter((key) => harness.hasValue(key)),
        ];
        if (mismatched.length > 0) {
          throw new Error(
            `This create needs ${PROXY_REQUIRED.join(', ')} set and ` +
              `${GITHUB_UNSET.join(', ')} empty; mismatched: ${mismatched.join(', ')}`,
          );
        }

        // a non-secret file, so only its names, never a credential, reach the guest
        const envFile = join(harness.runHome, `${name}.env`);
        await writeFile(
          envFile,
          Object.entries(RUNTIME_PROBE)
            .map(([key, value]) => `${key}=${value}\n`)
            .join(''),
        );

        await harness.withWorkstation(name, async () => {
          successData(
            await cli.json(
              [
                'create',
                '--name',
                name,
                '--network',
                'tailscale',
                '--no-use-exit-node',
                '--proxy',
                '--no-github',
                '--git-name',
                GIT_NAME,
                '--git-email',
                GIT_EMAIL,
                '--no-plugins',
                '--env-file',
                envFile,
                '--provider',
                type,
              ],
              CREATE_TIMEOUT_MS,
              signal,
            ),
            'create',
          );

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
              environment: {
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
          // the agent's runtime environment holds exactly the file's names;
          // execute redacts, so a credential the file wrongly held shows only
          // by its variable name
          expect(
            JSON.parse(
              await asRoot(provider, name, `cat ${RUNTIME_ENV_PATH}`),
            ) as unknown,
          ).toEqual(RUNTIME_PROBE);
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
}
