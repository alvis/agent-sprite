import type {
  RecordedProfile,
  WorkstationMetadata,
  WorkstationSetupState,
} from '#drivers/contracts';

/** marks a machine open-agent manages */
export const MANAGED_KEY = 'open-agent';
/** the value of the ownership key */
export const MANAGED_VALUE = 'managed';
/** names the compact control-plane schema */
export const SCHEMA_KEY = 'open-agent-schema';
/** the schema this driver writes */
export const SCHEMA_VERSION = '1';
/** records the setup state of the current provisioning attempt */
export const SETUP_KEY = 'open-agent-setup';
/** records the open-agent release that last set the machine up */
export const VERSION_KEY = 'open-agent-version';
/** one key per profile summary field; harnesses are comma-separated */
const PROFILE_KEYS = {
  provider: 'open-agent-provider',
  agent: 'open-agent-agent',
  harnesses: 'open-agent-harnesses',
  network: 'open-agent-network',
} as const;
const HARNESS_SEPARATOR = ',';
/** what the metadata API takes as a request to remove a key */
const REMOVED = '';

/**
 * tells whether a machine carries the ownership key
 * @param metadata machine metadata
 * @returns true for an open-agent machine
 */
export function isManagedMetadata(
  metadata: Readonly<Record<string, string>> | undefined,
): boolean {
  return metadata?.[MANAGED_KEY] === MANAGED_VALUE;
}

/**
 * builds the metadata a new machine is created with: ownership, schema and
 * profile summary, but no setup state until setup records one
 * @param summary driver selection to record
 * @returns machine metadata; never credentials
 */
export function creationMetadata(
  summary: RecordedProfile,
): Record<string, string> {
  return {
    [MANAGED_KEY]: MANAGED_VALUE,
    [SCHEMA_KEY]: SCHEMA_VERSION,
    ...profileEntries(summary),
  };
}

/**
 * encodes a metadata update; an unrecorded setup state removes its key, and
 * an absent profile summary or version leaves the recorded one untouched
 * @param metadata setup state, optional profile summary and optional version
 * @returns keys to set, or to remove with an empty value
 */
export function metadataUpdate(
  metadata: WorkstationMetadata,
): Record<string, string> {
  return {
    [SETUP_KEY]: setupValue(metadata.setup),
    ...(metadata.profile ? profileEntries(metadata.profile) : {}),
    ...(metadata.version ? { [VERSION_KEY]: metadata.version } : {}),
  };
}

/**
 * decodes setup state, profile summary and version without waking the machine
 * @param metadata machine metadata
 * @returns recorded metadata
 */
export function readMetadata(
  metadata: Readonly<Record<string, string>> | undefined,
): WorkstationMetadata {
  const setup = metadata?.[SETUP_KEY];
  const profile = metadata && readProfile(metadata);
  const version = metadata?.[VERSION_KEY];

  return {
    setup: setup === 'ready' || setup === 'incomplete' ? setup : 'not recorded',
    ...(profile ? { profile } : {}),
    ...(version ? { version } : {}),
  };
}

/**
 * encodes the profile summary, one key per field
 * @param summary driver selection
 * @returns metadata entries
 */
function profileEntries(summary: RecordedProfile): Record<string, string> {
  return {
    [PROFILE_KEYS.provider]: summary.provider,
    [PROFILE_KEYS.agent]: summary.agent,
    [PROFILE_KEYS.harnesses]: summary.harnesses.join(HARNESS_SEPARATOR),
    [PROFILE_KEYS.network]: summary.network,
  };
}

/**
 * encodes a setup state as its metadata value
 * @param setup setup state
 * @returns the value, or the removal marker for an unrecorded state
 */
function setupValue(setup: WorkstationSetupState): string {
  return setup === 'not recorded' ? REMOVED : setup;
}

/**
 * decodes the profile summary
 * @param metadata machine metadata
 * @returns the summary, or undefined when any field is absent
 */
function readProfile(
  metadata: Readonly<Record<string, string>>,
): RecordedProfile | undefined {
  const provider = metadata[PROFILE_KEYS.provider];
  const agent = metadata[PROFILE_KEYS.agent];
  const network = metadata[PROFILE_KEYS.network];
  const harnesses = (metadata[PROFILE_KEYS.harnesses] ?? '')
    .split(HARNESS_SEPARATOR)
    .filter((harness) => harness !== '');

  return provider && agent && network && harnesses.length > 0
    ? { provider, agent, harnesses, network }
    : undefined;
}
