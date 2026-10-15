/**
 * how T3 names each harness it supports in its provider list, keyed by
 * harness driver id; the single list of the harnesses T3 supports, so a
 * harness without an entry is unsupported; dependency-free so the payload
 * pipeline and the guest catalog can read it, and the agent driver's
 * `supportedHarnesses` checks every key is a registered harness
 */
export const T3_HARNESS_NAMES = {
  claude: 'claudeAgent',
  codex: 'codex',
} as const;

/** a harness T3 supports */
export type T3HarnessId = keyof typeof T3_HARNESS_NAMES;

/** the harnesses T3 supports, in the order T3_HARNESS_NAMES lists them */
export const T3_HARNESSES: readonly T3HarnessId[] = Object.keys(
  T3_HARNESS_NAMES,
).filter((id): id is T3HarnessId => Object.hasOwn(T3_HARNESS_NAMES, id));
