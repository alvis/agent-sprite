import { driverModule } from '#guest/guest-root';

import type { GuestPayload } from '#drivers/contracts';

const folder = 'harnesses/codex';

/** compiled module that trusts Codex's hooks */
export const CODEX_HOOKS_TRUST_MODULE = driverModule(
  folder,
  'codex-hooks-trust.js',
);

/** compiled module that lists the skills Codex loaded */
export const CODEX_SKILLS_PROBE_MODULE = driverModule(
  folder,
  'codex-skills-probe.js',
);

/** compiled guest modules Codex contributes to the deployable payload */
export const CODEX_GUEST_MODULES: readonly GuestPayload[] = [
  { module: CODEX_HOOKS_TRUST_MODULE, account: 'agent' },
  { module: CODEX_SKILLS_PROBE_MODULE, account: 'agent' },
];
