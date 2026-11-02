import type { MachineType } from '../providers';

/**
 * maximum time allowed for workstation creation, by machine type: a Fly
 * Machine installs the whole tool set from bottles and packages
 */
export const CREATE_TIMEOUT_MS: Readonly<Record<MachineType, number>> = {
  'sprite': 1_200_000,
  'fly-machine': 3_600_000,
};

/** maximum time allowed for workstation commands */
export const COMMAND_TIMEOUT_MS = 480_000;

/** maximum time allowed for read-only CLI commands */
export const READ_TIMEOUT_MS = 120_000;

/** maximum time allowed for network device authorization */
export const DEVICE_TIMEOUT_MS = 60_000;

/** interval between network device authorization checks */
export const DEVICE_POLL_MS = 5_000;
