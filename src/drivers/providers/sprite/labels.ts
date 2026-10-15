import type {
  RecordedProfile,
  WorkstationMetadata,
  WorkstationSetupState,
} from '#drivers/contracts';

/** identifies managed Sprites */
export const MANAGED_LABEL = 'open-agent';
/** identifies the compact control-plane schema */
export const SCHEMA_LABEL = 'open-agent-schema-v1';
/** marks a completed current provisioning attempt */
export const SETUP_READY_LABEL = 'open-agent-setup-ready';
/** marks a workstation that needs a targeted setup retry */
export const SETUP_INCOMPLETE_LABEL = 'open-agent-setup-incomplete';
const SETUP_LABELS: readonly string[] = [
  SETUP_READY_LABEL,
  SETUP_INCOMPLETE_LABEL,
];
/** prefixes the open-agent release that last set the Sprite up */
export const VERSION_LABEL_PREFIX = `${MANAGED_LABEL}-version-`;
// a label holds lowercase letters, digits and hyphens, so a version's dots
// become hyphens and its prerelease follows a double hyphen; a version with a
// hyphen, an uppercase letter or build metadata in it has no label
const LABELLED_VERSION =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z]+(?:\.[0-9a-z]+)*))?$/;
const VERSION_IN_LABEL = /^(\d+)-(\d+)-(\d+)(?:--([0-9a-z]+(?:-[0-9a-z]+)*))?$/;
// one label per summary field keeps every value a short lowercase DNS label
const PROFILE_LABEL_PREFIXES = {
  provider: `${MANAGED_LABEL}-provider-`,
  agent: `${MANAGED_LABEL}-agent-`,
  harness: `${MANAGED_LABEL}-harness-`,
  network: `${MANAGED_LABEL}-network-`,
} as const;

/**
 * decodes setup state, profile summary and version without waking the Sprite
 * @param labels current Sprite labels
 * @returns recorded metadata
 */
export function readMetadataLabels(
  labels: readonly string[],
): WorkstationMetadata {
  const version = readVersionLabel(labels);

  return {
    setup: labels.includes(SETUP_READY_LABEL)
      ? 'ready'
      : labels.includes(SETUP_INCOMPLETE_LABEL)
        ? 'incomplete'
        : 'not recorded',
    profile: readProfileSummary(labels),
    ...(version ? { version } : {}),
  };
}

/**
 * merges owned metadata labels without disturbing labels installed by other
 * systems; a recorded setup state, profile summary or version replaces its
 * whole family
 * @param current current Sprite labels
 * @param metadata setup state, optional profile summary and optional version to record
 * @returns the complete label set to store
 */
export function mergeMetadataLabels(
  current: readonly string[],
  metadata: WorkstationMetadata,
): string[] {
  const version = metadata.version && versionLabel(metadata.version);
  const labels = [
    ...setupLabels(metadata.setup),
    ...(metadata.profile ? profileSummaryLabels(metadata.profile) : []),
    ...(version ? [version] : []),
  ];
  const replacesProfile = metadata.profile !== undefined;
  const replacesVersion = metadata.version !== undefined;
  const retained = current.filter(
    (label) =>
      !SETUP_LABELS.includes(label) &&
      !(replacesProfile && isProfileSummaryLabel(label)) &&
      !(replacesVersion && label.startsWith(VERSION_LABEL_PREFIX)),
  );

  return [...new Set([...retained, ...labels])];
}

/**
 * encodes the compact profile summary as owned labels; never credentials
 * @param summary driver selection to record
 * @returns one label per summary field
 */
export function profileSummaryLabels(summary: RecordedProfile): string[] {
  return [
    `${PROFILE_LABEL_PREFIXES.provider}${summary.provider}`,
    `${PROFILE_LABEL_PREFIXES.agent}${summary.agent}`,
    ...summary.harnesses.map(
      (harness) => `${PROFILE_LABEL_PREFIXES.harness}${harness}`,
    ),
    `${PROFILE_LABEL_PREFIXES.network}${summary.network}`,
  ];
}

/**
 * encodes a setup state as its owned label
 * @param setup provider-recorded setup state
 * @returns the state's label, or none for an unrecorded state
 */
function setupLabels(setup: WorkstationSetupState): string[] {
  switch (setup) {
    case 'ready':
      return [SETUP_READY_LABEL];
    case 'incomplete':
      return [SETUP_INCOMPLETE_LABEL];
    default:
      return [];
  }
}

/**
 * decodes the profile summary
 * @param labels current Sprite labels
 * @returns the recorded summary, or undefined when it is absent or incomplete
 */
function readProfileSummary(
  labels: readonly string[],
): RecordedProfile | undefined {
  const values = (prefix: string): string[] =>
    labels
      .filter((label) => label.startsWith(prefix))
      .map((label) => label.slice(prefix.length));
  const [provider, ...extraProviders] = values(PROFILE_LABEL_PREFIXES.provider);
  const [agent, ...extraAgents] = values(PROFILE_LABEL_PREFIXES.agent);
  const [network, ...extraNetworks] = values(PROFILE_LABEL_PREFIXES.network);
  const harnesses = values(PROFILE_LABEL_PREFIXES.harness);

  return provider !== undefined &&
    agent !== undefined &&
    network !== undefined &&
    extraProviders.length + extraAgents.length + extraNetworks.length === 0 &&
    harnesses.length > 0
    ? { provider, agent, harnesses, network }
    : undefined;
}

/**
 * tells whether a label belongs to the owned profile-summary family
 * @param label Sprite label
 * @returns true for a profile-summary label
 */
function isProfileSummaryLabel(label: string): boolean {
  return Object.values(PROFILE_LABEL_PREFIXES).some((prefix) =>
    label.startsWith(prefix),
  );
}

/**
 * encodes a version as its owned label
 * @param version open-agent release
 * @returns the label, or undefined when the version cannot be one
 */
function versionLabel(version: string): string | undefined {
  const match = LABELLED_VERSION.exec(version);
  if (!match) {
    return undefined;
  }
  const [, major, minor, patch, prerelease] = match;
  const core = `${major}-${minor}-${patch}`;
  const suffix = prerelease ? `--${prerelease.replaceAll('.', '-')}` : '';

  return `${VERSION_LABEL_PREFIX}${core}${suffix}`;
}

/**
 * decodes the recorded version
 * @param labels current Sprite labels
 * @returns the version, or undefined when none or more than one is recorded
 */
function readVersionLabel(labels: readonly string[]): string | undefined {
  const values = labels
    .filter((label) => label.startsWith(VERSION_LABEL_PREFIX))
    .map((label) =>
      VERSION_IN_LABEL.exec(label.slice(VERSION_LABEL_PREFIX.length)),
    );
  const [match, ...extra] = values;
  if (!match || extra.length > 0) {
    return undefined;
  }
  const [, major, minor, patch, prerelease] = match;
  const core = `${major}.${minor}.${patch}`;

  return prerelease ? `${core}-${prerelease.replaceAll('-', '.')}` : core;
}
