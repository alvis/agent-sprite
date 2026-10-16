import { catalog } from '#core/catalog';
import { networkDriver } from '#core/networks';
import { readAsset } from '#integrations/guest/assets';
import { AGENT_HOME } from '#integrations/guest/layout';
import { backendAssets } from '#services/backends';
import {
  HOMEBREW_LIBRARY,
  LINKS_LIBRARY,
  NPM_LIBRARY,
  RUSTUP_LIBRARY,
} from '#tools/libraries';

import { AWAKE_ASSET } from '../awake';
import { UPDATE_GATE_ASSET, UPDATER_ASSET } from '../updates';

import { assetStep, assetStepId } from './steps/file';
import { homebrewStep } from './steps/homebrew';
import { libraryCommand } from './steps/library';

import type { WorkstationProfile } from '#core/profile';
import type { ProviderDriver } from '#drivers/contracts';
import type { GuestAsset, OsFamily, OsRelease } from '#os/contracts';
import type { Resolution, ToolSpec } from '#tools/contracts';

import type { SetupStep } from './contracts';

/** id of the step that creates the agent account */
const ACCOUNTS_STEP = 'accounts';
/** id of the step that installs the bootstrap system packages, cron among them */
export const BOOTSTRAP_STEP = 'bootstrap';
/** id of the best-effort step that lets every group open ping sockets */
const SYSCTL_STEP = 'sysctl:ping';

/**
 * the agent account's user and group id, the one the Fly boot hook restores
 * too; it stays clear of 1000, the first user an image adds, such as the
 * `ubuntu` account of the Sprite image
 */
const AGENT_IDS = '2000';
/** longest one command of the account step may take */
const ACCOUNTS_LIMIT_MS = 60_000;
/** longest one command of the bootstrap step may take, its lock wait included */
const BOOTSTRAP_LIMIT_MS = 1_200_000;
/** longest one command of the sysctl step may take */
const SYSCTL_LIMIT_MS = 30_000;
/** the group range that lets every account open an unprivileged ping socket */
const PING_GROUP_RANGE = '0 2147483647';

/** the provider facts a plan is assembled from */
export type PlanProvider = Pick<
  ProviderDriver,
  'id' | 'capabilities' | 'serviceBackend' | 'awakeAsset' | 'bootHookStep'
>;

/** what the foundation of a plan is built from */
interface FoundationContext {
  /** the provider, whose backend, adapter and boot hook are installed */
  provider: PlanProvider;
  /** the selection, whose agent and network bring launchers */
  profile: WorkstationProfile;
  /** the guest's release, as the session probed it */
  release: OsRelease;
  /** the guest's OS family */
  family: OsFamily;
  /** every tool setup resolved */
  tools: readonly ToolSpec[];
  /** the source picked for each tool */
  resolutions: readonly Resolution[];
}

/**
 * builds the steps every package step builds on: the guest programs, the
 * provider's boot hook before any package step, the agent account, the
 * bootstrap packages, Homebrew where a tool is poured from it, and the ping
 * sysctl
 * @param context the provider, selection, release, family and resolved tools
 * @returns the asset, boot hook, account, bootstrap, Homebrew and sysctl steps
 */
export async function foundationSteps(
  context: FoundationContext,
): Promise<SetupStep[]> {
  const { provider, family, release } = context;
  const assets = guestAssets(context);
  const installs = await Promise.all(
    assets.map(async (asset) =>
      assetStep(family, asset, await readAsset(asset)),
    ),
  );
  const libraries = assets.map(assetStepId);
  const bootHook = await provider.bootHookStep?.(libraries);
  const homebrew = family.homebrew(release);
  const brewTools = context.resolutions.flatMap((resolution) =>
    'source' in resolution && resolution.source.kind === 'brew'
      ? [resolution.tool]
      : [],
  );
  const required = new Set(
    context.tools.filter(({ required }) => required).map(({ name }) => name),
  );

  return [
    ...installs,
    ...(bootHook ? [bootHook] : []),
    accountsStep(family, [...libraries, ...(bootHook ? [bootHook.id] : [])]),
    bootstrapStep(family, family.bootstrapPackages(release)),
    ...(homebrew.supported && brewTools.length > 0
      ? [
          homebrewStep({
            family,
            prerequisites: homebrew.prerequisites,
            needs: [BOOTSTRAP_STEP],
            critical: brewTools.some((tool) => required.has(tool)),
          }),
        ]
      : []),
    sysctlStep(family),
  ];
}

/**
 * lists the guest programs setup installs before any step sources one: the
 * family's library and update fragment, the tool libraries, the service
 * backend's, the governor and the provider's awake adapter, the update gate
 * and updater, and the agent's and network's launchers
 * @param context the provider, the selection and the family
 * @returns each asset once
 */
function guestAssets(
  context: Pick<FoundationContext, 'provider' | 'profile' | 'family'>,
): GuestAsset[] {
  const { provider, profile, family } = context;
  const launcher = networkDriver(profile.network).launcher;
  const assets = [
    family.library,
    family.updaterFragment,
    HOMEBREW_LIBRARY,
    NPM_LIBRARY,
    RUSTUP_LIBRARY,
    LINKS_LIBRARY,
    ...backendAssets(provider.serviceBackend),
    AWAKE_ASSET,
    ...(provider.awakeAsset ? [provider.awakeAsset] : []),
    UPDATE_GATE_ASSET,
    UPDATER_ASSET,
    catalog.agents[profile.agent].launcher,
    ...(launcher ? [launcher.asset] : []),
  ];

  return [...new Map(assets.map((asset) => [asset.path, asset])).values()];
}

/**
 * renders calls into the family's library as one step command
 * @param family the guest's OS family
 * @param calls library functions and their arguments
 * @returns the command
 */
function library(
  family: OsFamily,
  calls: Parameters<typeof libraryCommand>[2],
): SetupStep['apply'] {
  return libraryCommand(family.shell, [family.library], calls);
}

/**
 * builds the step that creates the agent account with the ids the Fly boot
 * hook restores
 * @param family the guest's OS family
 * @param needs ids of the steps installing the library and the boot hook
 * @returns a critical step that ensures the account exists
 */
function accountsStep(family: OsFamily, needs: readonly string[]): SetupStep {
  return {
    id: ACCOUNTS_STEP,
    component: 'accounts',
    account: 'root',
    needs: [...needs],
    apply: library(family, [
      [
        'oa_account_ensure',
        'agent',
        AGENT_IDS,
        AGENT_IDS,
        AGENT_HOME,
        '/bin/bash',
        'user',
      ],
    ]),
    verify: { argv: ['id', '-u', 'agent'] },
    timeoutMs: ACCOUNTS_LIMIT_MS,
    critical: true,
    retry: 'transport',
  };
}

/**
 * builds the step that installs the family's bootstrap packages, cron among
 * them, skipping the install when all are present
 * @param family the guest's OS family
 * @param packages distribution packages the release bootstraps with
 * @returns a critical step that installs any package missing
 */
function bootstrapStep(
  family: OsFamily,
  packages: readonly string[],
): SetupStep {
  return {
    id: BOOTSTRAP_STEP,
    component: 'system packages',
    account: 'root',
    needs: [ACCOUNTS_STEP],
    check: library(family, [['oa_pkg_installed', ...packages]]),
    apply: library(family, [['oa_pkg_install', ...packages]]),
    verify: library(family, [['oa_pkg_installed', ...packages]]),
    timeoutMs: BOOTSTRAP_LIMIT_MS,
    critical: true,
    retry: 'transport',
  };
}

/**
 * builds the best-effort step that lets every account open an unprivileged
 * ping socket
 * @param family the guest's OS family
 * @returns a non-critical step setting net.ipv4.ping_group_range
 */
function sysctlStep(family: OsFamily): SetupStep {
  return {
    id: SYSCTL_STEP,
    component: 'sysctl',
    account: 'root',
    needs: [BOOTSTRAP_STEP],
    apply: library(family, [
      ['oa_sysctl', 'net.ipv4.ping_group_range', PING_GROUP_RANGE],
    ]),
    timeoutMs: SYSCTL_LIMIT_MS,
    critical: false,
    retry: 'transport',
  };
}
