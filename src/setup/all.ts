import { catalog } from '#core/catalog';
import { markInstallationReady } from '#integrations/guest/install';
import { traceStage } from '#operation';

import { installSetupPlan } from './install.js';
import { setupNetwork } from './network.js';
import { setupPlugins } from './plugins.js';
import {
  setupEnvironment,
  setupGit,
  setupGithub,
  setupProxy,
  setupAgent,
  stopService,
} from './sections.js';
import { exposeWhenServing } from './serving.js';

import type { AllSetupData } from '#command/data';
import type { GuestChannel } from '#drivers/guest-channel';

import type { SetupContext } from './context.js';

/**
 * reconciles every managed guest section: the setup plan installs the tools,
 * services and jobs, then the network, accounts, gateway, runtime environment
 * and plugins are configured, the agent is verified to serve and exposed, and
 * only then is the installation recorded ready
 * @param guest guest channel of the managed workstation
 * @param context full setup choices, prompts, and redaction values
 * @returns non-secret section outcomes after readiness succeeds
 */
export async function setupAll(
  guest: GuestChannel,
  context: SetupContext,
): Promise<AllSetupData> {
  const { interaction, profile } = context;
  interaction?.progress({
    stage: 'tools',
    message: 'Installing the guest environment and managed developer tools',
  });
  if (context.isReleaseChanged) {
    // the plan's service step starts the stopped agent on the selected release
    await stopService(guest, catalog.agents[profile.agent].service.name);
  }
  await installSetupPlan(context);
  const configured = await traceStage('setup.native.configuration', async () =>
    configureSections(guest, context),
  );
  await exposeWhenServing(guest, context);
  await markInstallationReady(guest);
  // the release was switched by the plan, not by pairing
  const agent = context.options.withPairCode
    ? await setupAgent(guest, { ...context, isReleaseChanged: false })
    : undefined;

  return { tools: 'updated', ...configured, ...agent };
}

/**
 * configures each section in turn through its owner, skipping those this run
 * opts out of
 * @param guest guest channel of the managed workstation
 * @param context full setup choices and mutation state
 * @returns the configured sections' outcomes
 */
async function configureSections(
  guest: GuestChannel,
  context: SetupContext,
): Promise<Omit<AllSetupData, 'tools'>> {
  const { options } = context;
  const network = await setupNetwork(guest, context);
  const github =
    options.github === false ? undefined : await setupGithub(guest, context);
  const git =
    options.gitIdentity === false ? undefined : await setupGit(guest, context);
  const proxy = await setupProxy(guest, context);
  const environment = options.envFile
    ? await setupEnvironment(guest, context)
    : undefined;
  const plugins =
    options.plugins === false ? undefined : await setupPlugins(guest, context);

  return {
    ...network,
    ...github,
    ...git,
    ...proxy,
    ...environment,
    ...plugins,
  };
}
