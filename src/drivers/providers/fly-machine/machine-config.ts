import {
  BOOT_INIT,
  BOOT_STUB_MODE,
  BOOT_STUB_PATH,
  VOLUME_PATH,
} from './boot-layout.js';
import { guestOf } from './machines.js';

import type { OsImage } from '#os/contracts';

import type { FlyMachineOffer } from './machines.js';
import type { FlyGuest, FlyServiceRoute } from './wire.js';

/** a file the machine writes to its root filesystem on every boot */
export interface MachineFile {
  /** absolute path on the root filesystem */
  guestPath: string;
  /** the file's text */
  contents: string;
  /** permission bits */
  mode: number;
}

/** the machine this driver creates, before it is rendered for the API */
export interface MachineSpec {
  /** stock image the machine boots */
  image: string;
  /** CPUs and memory the machine runs on */
  guest: FlyGuest;
  /** program and arguments the machine runs as its init */
  init: readonly string[];
  /** files written to the root filesystem before the init runs */
  files: readonly MachineFile[];
  /** whether the root filesystem outlives a stop: `always` keeps what setup installed there across restarts */
  rootfs: 'always';
  /** volume mounted as persistent storage */
  volume: string;
  /** where the volume is mounted */
  mountPath: string;
  /** ACP agent port the declared service routes public traffic to */
  port: number;
  /** ownership, schema and profile summary */
  metadata: Readonly<Record<string, string>>;
}

/** what a new machine needs beyond the fixed shape */
export interface MachineSpecParams {
  /** preset the machine runs on */
  machine: FlyMachineOffer;
  /** volume mounted as persistent storage */
  volume: string;
  /** the boot stub's text, which the machine writes to its root filesystem */
  bootStub: string;
  /** ACP agent port a later exposure publishes */
  port: number;
  /** initial machine metadata */
  metadata: Readonly<Record<string, string>>;
}

/** stock Debian; the boot hook restores everything else from the volume */
export const MACHINE_IMAGE = 'debian:bookworm-slim';
/** the OS images a workstation machine is created from */
export const FLY_MACHINE_IMAGES: readonly [OsImage, ...OsImage[]] = [
  {
    id: 'debian-12',
    ref: MACHINE_IMAGE,
    family: 'debian',
    release: { id: 'debian', versionId: '12' },
    // Fly Machines run on x86_64 hosts
    arch: ['x86_64'],
  },
];
/** volume name; Fly volume names allow only letters, digits and underscores */
export const VOLUME_NAME = 'open_agent';
/** persistent storage size */
export const VOLUME_SIZE_GB = 10;

/**
 * describes a workstation machine, whose init is the boot stub its
 * configuration writes to the root filesystem, which keeps across restarts;
 * the stub runs the boot hook setup keeps on the volume. Its service is
 * declared now because changing it later restarts the machine, and it stays
 * unreachable until exposure assigns the app public addresses
 * @param params preset, volume, boot stub, ACP agent port and initial metadata
 * @returns the machine description
 */
export function machineSpec(params: MachineSpecParams): MachineSpec {
  return {
    image: MACHINE_IMAGE,
    // a machine above 2 GB of memory cannot be suspended, only stopped
    guest: guestOf(params.machine),
    init: BOOT_INIT,
    files: [
      {
        guestPath: BOOT_STUB_PATH,
        contents: params.bootStub,
        mode: BOOT_STUB_MODE,
      },
    ],
    rootfs: 'always',
    volume: params.volume,
    mountPath: VOLUME_PATH,
    port: params.port,
    metadata: params.metadata,
  };
}

/**
 * tells whether a machine declares the service that publishes a port
 * @param routes services the machine declares
 * @param port ACP agent port
 * @returns true when the port is routed with proxy auto-start and no auto-stop
 */
export function declaresAgentService(
  routes: readonly FlyServiceRoute[],
  port: number,
): boolean {
  return routes.some(
    (route) =>
      route.internalPort === port &&
      route.autostart &&
      route.autostop === 'off',
  );
}
