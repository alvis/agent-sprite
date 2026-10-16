/** product name used by the packed executable, temporary paths and labels */
export const PRODUCT = 'open-agent';

/** retired name, assembled so a repository search for it finds only real leftovers */
export const RETIRED_PRODUCT = ['agent', 'sprite'].join('-');

/** prefix every workstation an e2e run creates carries, whatever the run */
export const E2E_NAME_PREFIX = 'oa-e2e-';

/** prefix of the variables holding e2e credentials, stripped before the CLI reads them */
export const TEST_PREFIX = 'TEST_';

/**
 * a cleanup scope: every e2e workstation (`oa-e2e-`), or one run's
 * (`oa-e2e-` and eight lowercase hex digits, then `-`)
 */
export const E2E_SCOPE = new RegExp(
  `^${E2E_NAME_PREFIX}(?:[0-9a-f]{8}-)?$`,
  'u',
);
