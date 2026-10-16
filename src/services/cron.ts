import { guestAsset } from '#integrations/guest/assets';
import { ENVIRONMENT_PATH } from '#integrations/guest/layout';
import { libraryCommand } from '#integrations/guest/plan/steps/library';
import { ROOT_ONLY_MODE } from '#os/contracts';

import type { ServiceDefinition } from '#drivers/guest-channel';
import type {
  SetupStep,
  StepCommand,
} from '#integrations/guest/plan/contracts';
import type { ServiceStepContext } from '#os/contracts';

/** the periodic job helpers: write each job environment.json records into cron's directory */
export const CRON_LIBRARY = guestAsset('services/cron.sh', ROOT_ONLY_MODE);

/** id of the step that installs the periodic jobs */
export const JOBS_STEP = 'services:jobs';

/** longest one command of the jobs step may take */
const JOBS_LIMIT_MS = 60_000;

/**
 * the cron daemon in the foreground, which runs the periodic jobs; every
 * backend runs it as one of its services, so no vendor init starts another
 */
export const cronService: ServiceDefinition = {
  name: 'open-agent-cron',
  command: '/usr/sbin/cron',
  arguments: ['-f'],
  account: 'root',
  needs: [],
};

/**
 * builds the step that writes the periodic jobs environment.json records into
 * cron's directory, which every backend shares; it is in place once the file
 * holds exactly those jobs
 * @param context the family and the steps that must succeed first
 * @returns the step that installs the jobs, checking first whether they are in place
 */
export function jobsStep(context: ServiceStepContext): SetupStep {
  const command = (call: string): StepCommand =>
    libraryCommand(
      context.family.shell,
      [CRON_LIBRARY],
      [[call, ENVIRONMENT_PATH]],
    );

  return {
    id: JOBS_STEP,
    component: 'cron',
    account: 'root',
    needs: [...context.needs],
    check: command('oa_cron_check'),
    apply: command('oa_cron_install'),
    verify: command('oa_cron_check'),
    timeoutMs: JOBS_LIMIT_MS,
    critical: true,
    retry: 'transport',
  };
}
