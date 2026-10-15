/** product name used by the packed executable, temporary paths and labels */
export const PRODUCT = 'open-agent';

/** retired name, assembled so a repository search for it finds only real leftovers */
export const RETIRED_PRODUCT = ['agent', 'sprite'].join('-');

/** environment variable prefix shared with scripts/packed-cli.ts */
export const ENVIRONMENT_PREFIX = 'OPEN_AGENT';

/** prefix shared by every workstation created by a live run */
export const LIVE_NAME_PREFIX = 'oa-live';

/** a run id is the shared prefix followed by eight lowercase hex digits */
export const LIVE_RUN_ID = new RegExp(`^${LIVE_NAME_PREFIX}-[0-9a-f]{8}$`, 'u');

/** the live project of the Fly Machine probe, whose cleanup sweeps Fly apps */
export const FLY_LIVE_PROJECT = `${PRODUCT}:LIVE-FLY`;
