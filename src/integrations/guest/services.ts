import { catalog } from '#core/catalog';
import { GUEST_LEAVES } from '#core/guest-leaves';
import { harnessDrivers } from '#core/harnesses';
import {
  agentService,
  CRON_SERVICE,
  isSupervisedProvider,
} from '#core/services';
import { kernelModule } from '#guest/guest-root';
import { supervisorEntryScript } from '#guest/supervisor/entry';
import { SUPERVISOR_COMMAND } from '#guest/supervisor/protocol';
import {
  UPDATE_CHECK_FILE,
  UPDATE_GATE_SCRIPT,
  updateEntryCommand,
} from '#guest/update-schedule';

import { writeGuestFile } from '../guest.js';

import { writeComponentCatalog } from './component-catalog.js';
import { writeHarnessCatalog } from './harness-catalog.js';
import { readGuestManifest } from './manifest.js';
import { readGuestPayload } from './payloads/assets.js';
import { deployGuestPayload } from './payloads.js';
import { withGuestTransaction } from './transaction.js';

import type { GuestPayload } from '#drivers/contracts';
import type { GuestChannel } from '#drivers/guest-channel';

const CRON_UPDATE_PATH = '/etc/cron.d/open-agent';
const SHARED_FILE_MODE = 0o644;
const ROOT_FILE_MODE = 0o600;
const ROOT_SCRIPT_MODE = 0o700;

/**
 * installs the agent and the maintenance schedule as independent services:
 * foreground cron where the provider runs the services, and the guest
 * supervisor's own timer where the supervisor does; a running agent keeps its
 * process unless the caller has just installed another release of it, which
 * only a restart loads
 * @param guest target guest
 * @param restart what the caller needs restarted
 * @param restart.isAgentRestarted whether the running agent service must stop
 * and start again, because its installed release changed
 */
export async function installManagedServices(
  guest: GuestChannel,
  restart: { isAgentRestarted: boolean } = { isAgentRestarted: false },
): Promise<void> {
  await withGuestTransaction(guest, async () => {
    const { profile } = await readGuestManifest(guest);
    const harnesses = harnessDrivers(profile.harnesses);
    const agent = catalog.agents[profile.agent];
    await writeHarnessCatalog(guest, harnesses);
    await writeComponentCatalog(guest, profile);
    // each module keeps the one mode the payload table gives it: root imports
    // both catalog readers, so they stay root-owned, and the agent only reads
    // them
    for (const module of [
      'harness-catalog.js',
      'component-catalog.js',
      'update-schedule.js',
      'native-files.js',
    ]) {
      await deployGuestPayload(guest, kernelModule(module));
    }
    await deployDriverModules(guest, agent.guest);
    await deployDriverModules(
      guest,
      Object.values(GUEST_LEAVES.shared).flatMap(({ guest }) => guest),
    );
    for (const { guest: payloads } of harnesses) {
      await deployDriverModules(guest, payloads);
    }
    await agent.verifyStartup(guest);
    if (restart.isAgentRestarted) {
      await stopAgentService(guest, agentService(profile).name);
    }
    await guest.services.ensure(agentService(profile));
    await installUpdateSchedule(
      guest,
      profile.options.updateCheckIntervalMinutes,
    );
    // the guest supervisor's own timer runs the schedule where it supervises
    if (isSupervisedProvider(profile.provider)) {
      return;
    }
    await guest.services.ensure({
      name: CRON_SERVICE,
      command: '/usr/sbin/cron',
      arguments: ['-f'],
      account: 'root',
      needs: [],
    });
  });
}

/**
 * stops the agent service when it is registered and not already stopped, so
 * the next ensure starts it from the installed release
 * @param guest target guest
 * @param name agent service identifier
 * @throws {Error} when the service reports a stop failure
 */
async function stopAgentService(
  guest: GuestChannel,
  name: string,
): Promise<void> {
  const service = (await guest.services.list()).find(
    (entry) => entry.name === name,
  );
  if (
    service &&
    service.status !== 'stopped' &&
    !(await guest.services.stop(name))
  ) {
    throw new Error('The agent service reported a stop failure');
  }
}

/**
 * installs the update schedule for a check interval: the root-owned interval
 * file every timer reads, the gate, and, where the provider runs the
 * services, a cron entry that runs the shared update entry every minute,
 * which starts the updater only when the gate lets a check through; the guest
 * supervisor's timer runs the same entry where it supervises them, so no cron
 * entry is written there. The entry never changes with the interval, so
 * changing the interval rewrites one file and touches no service. Rewriting
 * them is idempotent, so a kernel refresh redeploys the gate and the entry.
 * @param guest target guest
 * @param minutes whole minutes between update checks
 */
export async function installUpdateSchedule(
  guest: GuestChannel,
  minutes: number,
): Promise<void> {
  await withGuestTransaction(guest, async () => {
    const { profile } = await readGuestManifest(guest);
    // a root-only shell script beside the kernel, not a staged module
    await writeGuestFile(guest, {
      path: UPDATE_GATE_SCRIPT,
      contents: await readGuestPayload(kernelModule('update-gate.sh')),
      mode: ROOT_SCRIPT_MODE,
    });
    await writeGuestFile(guest, {
      path: UPDATE_CHECK_FILE,
      contents: `${String(minutes)}\n`,
      mode: ROOT_FILE_MODE,
    });
    // the one seam to the provider's timer: cron runs the shared update entry
    // every minute, and the guest supervisor's timer runs the same entry
    if (isSupervisedProvider(profile.provider)) {
      return;
    }
    await writeGuestFile(guest, {
      path: CRON_UPDATE_PATH,
      contents: `* * * * * root /bin/sh -c '${updateEntryCommand()}' >/dev/null 2>&1\n`,
      mode: SHARED_FILE_MODE,
    });
  });
}

/**
 * installs the guest supervisor's command entry, root's alone, which the
 * provider's init runs once it exists; the supervisor's modules are staged
 * with the rest of the kernel, and the entry checks them before it runs them.
 * The installer writes it before any service is ensured, since the network's
 * daemon is ensured before the managed services are
 * @param guest target guest
 */
export async function installSupervisor(guest: GuestChannel): Promise<void> {
  await writeGuestFile(guest, {
    path: SUPERVISOR_COMMAND,
    contents: supervisorEntryScript(),
    mode: ROOT_SCRIPT_MODE,
  });
}

/**
 * deploys the modules a driver contributes; each keeps the mode its driver's
 * declared account gives it, so every one stays root-owned
 * @param guest target guest
 * @param payloads the driver's compiled guest modules
 */
async function deployDriverModules(
  guest: GuestChannel,
  payloads: readonly GuestPayload[],
): Promise<void> {
  for (const { module } of payloads) {
    await deployGuestPayload(guest, module);
  }
}
