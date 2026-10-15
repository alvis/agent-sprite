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
// one label per summary field keeps every value a short lowercase DNS label
const PROFILE_LABEL_PREFIXES = {
  provider: `${MANAGED_LABEL}-provider-`,
  agent: `${MANAGED_LABEL}-agent-`,
  harness: `${MANAGED_LABEL}-harness-`,
  network: `${MANAGED_LABEL}-network-`,
} as const;

/**
 * decodes setup state and profile summary without waking the Sprite
 * @param labels current Sprite labels
 * @returns recorded metadata
 */
export function readMetadataLabels(
  labels: readonly string[],
): WorkstationMetadata {
  return {
    setup: labels.includes(SETUP_READY_LABEL)
      ? 'ready'
      : labels.includes(SETUP_INCOMPLETE_LABEL)
        ? 'incomplete'
        : 'not recorded',
    profile: readProfileSummary(labels),
  };
}

/**
 * merges owned metadata labels without disturbing labels installed by other
 * systems; a recorded setup state or profile summary replaces its whole family
 * @param current current Sprite labels
 * @param metadata setup state and optional profile summary to record
 * @returns the complete label set to store
 */
export function mergeMetadataLabels(
  current: readonly string[],
  metadata: WorkstationMetadata,
): string[] {
  const labels = [
    ...setupLabels(metadata.setup),
    ...(metadata.profile ? profileSummaryLabels(metadata.profile) : []),
  ];
  const replacesProfile = metadata.profile !== undefined;
  const retained = current.filter(
    (label) =>
      !SETUP_LABELS.includes(label) &&
      !(replacesProfile && isProfileSummaryLabel(label)),
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
