/** the boot hook steps the Fly E2E run expects to observe in order */
export const BOOT_STEPS = [
  'secrets',
  'volume',
  'guest-root',
  'libraries',
  'agent-account',
  'homebrew-account',
  'apt-cache',
  'packages',
  'links',
  'services',
  'profile',
  'label',
  'ping',
] as const;
