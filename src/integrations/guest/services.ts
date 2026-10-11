import { ensureGuestService, runGuest, writeGuestFile } from '../guest.js';

import { ownGuestFile, runAsAgent } from './account.js';
import { guestIntegrations, readGuestManifest } from './manifest.js';
import { PAYLOAD_DIRECTORY, deployGuestPayload } from './payloads.js';
import { withGuestTransaction } from './transaction.js';

import type { Sprite } from '@fly/sprites';

const T3_SERVICE = 't3-code';
const TAILSCALE_SERVICE = 'tailscaled';
const CRON_SERVICE = 'agent-sprite-cron';
const UPDATE_LOCK_PATH = '/var/lock/agent-sprite-update.lock';
const AGENT_SCRIPT_MODE = 0o755;
const SHARED_FILE_MODE = 0o644;

/**
 * installs T3 and foreground cron as independent supervised services
 * @param sprite target guest
 */
export async function installManagedServices(sprite: Sprite): Promise<void> {
  await withGuestTransaction(sprite, async () => {
    const integrations = guestIntegrations(await readGuestManifest(sprite));
    await deployAgentPayload(sprite, 't3-launcher.js');
    await deployGuestPayload(sprite, 'update-schedule.js');
    await deployGuestPayload(sprite, 'native-files.js', AGENT_SCRIPT_MODE);
    for (const filename of [
      'update-manifest.js',
      'update-options.js',
      'update-services.js',
      'update-versions.js',
      'updater-diagnostics.js',
      'updater-lifecycle.js',
      'updater.js',
    ]) {
      await deployGuestPayload(sprite, filename);
    }
    await deployAgentPayload(sprite, 'hub-probe.js');
    await deployAgentPayload(sprite, 'claude-init-probe.js');
    await deployProviderProbes(sprite);
    await verifyT3StartupFlags(sprite);
    await ensureGuestService(sprite, T3_SERVICE, {
      cmd: '/usr/sbin/runuser',
      args: [
        '-u',
        'agent',
        '--',
        '/opt/agent-sprite/node/bin/node',
        `${PAYLOAD_DIRECTORY}/t3-launcher.js`,
      ],
      needs: integrations.tailscale ? [TAILSCALE_SERVICE] : [],
      httpPort: 3773,
    });
    await writeGuestFile(sprite, {
      path: '/etc/cron.d/agent-sprite',
      contents: `*/30 * * * * root /bin/sh -c 'exec 9>>${UPDATE_LOCK_PATH}; /usr/bin/flock -n 9 || exit 0; exec /opt/agent-sprite/node/bin/node /opt/agent-sprite/updater.js' >/dev/null 2>&1\n`,
      mode: SHARED_FILE_MODE,
    });
    await ensureGuestService(sprite, CRON_SERVICE, {
      cmd: '/usr/sbin/cron',
      args: ['-f'],
    });
  });
}

/**
 * checks required private T3 startup options before supervising it
 * @param sprite target guest
 */
async function verifyT3StartupFlags(sprite: Sprite): Promise<void> {
  const help = await runAsAgent(sprite, [
    '/home/agent/.local/bin/t3',
    'start',
    '--help',
  ]);
  if (
    !help.stdout.includes('--log-level') ||
    !help.stdout.includes('--no-browser')
  ) {
    throw new Error('Installed T3 lacks the required private startup flags');
  }
}

/**
 * deploys agent-readable native and running-service discovery probes
 * @param sprite target guest
 */
async function deployProviderProbes(sprite: Sprite): Promise<void> {
  await runGuest(sprite, [
    '/bin/mkdir',
    '-p',
    `${PAYLOAD_DIRECTORY}/t3-provider-probe`,
  ]);
  for (const filename of [
    'codex-skills-probe.js',
    't3-provider-probe.js',
    't3-provider-probe/rpc.js',
  ]) {
    await deployAgentPayload(sprite, filename);
  }
}

/**
 * deploys one guest payload and makes it readable by the agent account
 * @param sprite target guest
 * @param filename bundled script filename
 */
async function deployAgentPayload(
  sprite: Sprite,
  filename: string,
): Promise<void> {
  await deployGuestPayload(sprite, filename);
  await ownGuestFile(sprite, `${PAYLOAD_DIRECTORY}/${filename}`);
}
