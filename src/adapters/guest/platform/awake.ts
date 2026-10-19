import { guestAsset } from '#adapters/guest/platform/assets';
import { SHARED_MODE } from '#domain/guest';

/**
 * the idle governor and awake command, root's file every account runs:
 * harness hooks record awake events with it as the agent, root records
 * managed holds and runs the per-minute tick
 */
export const AWAKE_ASSET = guestAsset('governor/awake.sh', SHARED_MODE);

/** the awake command harness hooks and managed holds run */
export const AWAKE_COMMAND = AWAKE_ASSET.installAs;

/** an awake event the command records */
export type AwakeAction = 'heartbeat' | 'hold-open' | 'hold-close';

/** longest budget, in milliseconds, an awake event may be given */
export const AWAKE_DEADLINE_MS = 8_000;
