import type {
  GuestServiceControl,
  ServiceDefinition,
} from '#drivers/guest-channel';
import type { SetupStep } from '#integrations/guest/plan/contracts';
import type { GuestSession } from '#integrations/guest/session/contracts';
import type { ToolOwner, ToolSpec } from '#tools/contracts';

/** an OS family every provider running it shares, named after its root distribution */
export type OsFamilyId = 'debian';

/** a CPU architecture as `uname -m` reports it on Linux */
export type CpuArch = 'x86_64' | 'aarch64';

/** the C library a guest links against */
type Libc = 'glibc' | 'musl';

/** what a guest reports about its own OS, read from `/etc/os-release`, `uname -m` and its loader */
export interface OsRelease {
  /** family the release belongs to */
  family: OsFamilyId;
  /** distribution, as `ID` names it, such as `debian` or `ubuntu` */
  id: string;
  /** release, as `VERSION_ID` names it, such as `12` */
  versionId: string;
  /** release codename, as `VERSION_CODENAME` names it, such as `bookworm`; absent when the release states none */
  codename?: string;
  /** CPU architecture */
  arch: CpuArch;
  /** C library */
  libc: Libc;
}

/** one OS image a provider can create a workstation from */
export interface OsImage {
  /** identifier, unique within the provider */
  id: string;
  /** reference the provider passes when it creates a machine; absent when the provider boots its own image and takes none */
  ref?: string;
  /** family of the image */
  family: OsFamilyId;
  /** distribution and release; absent when the provider picks the release, so only the guest can tell */
  release?: Pick<OsRelease, 'id' | 'versionId'>;
  /** architectures a machine of the image may report */
  arch: readonly [CpuArch, ...CpuArch[]];
}

/** where a tool source is usable; every field present must match, an absent one matches anything */
export interface OsConstraint {
  /** families the source supports */
  families?: readonly OsFamilyId[];
  /** distributions, as `ID` names them */
  ids?: readonly string[];
  /** architectures */
  arch?: readonly CpuArch[];
  /** C library */
  libc?: Libc;
}

/** installed mode of a guest program only root runs */
export const ROOT_ONLY_MODE = 0o700;

/** installed mode of a guest program other accounts run too */
export const SHARED_MODE = 0o755;

/** a guest program shipped as a `.sh` file under the package's `guest` directory and installed root-owned */
export interface GuestAsset {
  /** path of the `.sh` file relative to the package's `guest` directory, which is its path under the guest root, such as `os/debian/lib.sh` */
  path: string;
  /** installed mode: shared when other accounts run it, root-only when only root does */
  mode: typeof ROOT_ONLY_MODE | typeof SHARED_MODE;
  /** absolute guest path it is installed at */
  installAs: string;
}

/** the outcome of asking a family whether a release can run Homebrew */
export type HomebrewSupport =
  | {
      /** Homebrew runs on the release */
      supported: true;
      /** system packages Homebrew needs before its installer runs */
      prerequisites: readonly string[];
    }
  | {
      /** Homebrew does not run on the release */
      supported: false;
      /** why, as reported to the user */
      reason: string;
    };

/** a distribution family's layer of host-driven setup, shared by every provider that runs it */
export interface OsFamily {
  /** family identifier */
  id: OsFamilyId;
  /**
   * tells whether an `/etc/os-release` belongs to the family, by `ID` or `ID_LIKE`
   * @param osRelease the parsed `/etc/os-release` fields
   * @returns true when the release is one of the family's
   */
  matches(osRelease: Readonly<Record<string, string>>): boolean;
  /** absolute path of the POSIX shell a session runs, such as `/bin/dash` */
  shell: string;
  /** programs a session needs on the guest before it runs any command */
  sessionCommands: readonly string[];
  /**
   * renders the program prefix that runs a command as an account; empty for
   * root. It stays a program, never a shell function, so it can follow
   * `setsid` and `timeout`
   * @param account account the command runs as
   * @returns program and arguments placed before the command
   */
  runAs(account: ToolOwner): readonly string[];
  /**
   * lists the system packages every setup installs first, cron included
   * @param release the guest's release
   * @returns package names
   */
  bootstrapPackages(release: OsRelease): readonly string[];
  /**
   * tells whether Homebrew runs on a release, architecture and C library
   * @param release the guest's release
   * @returns the support and its prerequisites, or why it is unsupported
   */
  homebrew(release: OsRelease): HomebrewSupport;
  /** the family's helper library, sourced by setup, the updater and the boot hook */
  library: GuestAsset;
  /** the system-package fragment of the updater */
  updaterFragment: GuestAsset;
}

/** who runs the guest services: the provider itself, or a backend setup installs */
export type ServiceBackendId = 'provider' | 'runit';

/** a command the service backend runs on a fixed schedule */
export interface PeriodicJob {
  /** job identifier */
  name: string;
  /** minutes between two runs */
  everyMinutes: number;
  /** program, arguments and account each run executes */
  run: Pick<ServiceDefinition, 'command' | 'arguments' | 'account'>;
}

/** what a backend's setup steps are built with */
export interface ServiceStepContext {
  /** the guest's OS family, whose shell every step runs */
  family: Pick<OsFamily, 'shell'>;
  /** ids of the steps that must succeed first, such as the one writing environment.json */
  needs: readonly string[];
}

/** a backend setup installs to run the guest services, for a provider that runs none itself */
export interface ServiceBackend {
  /** backend identifier */
  id: Exclude<ServiceBackendId, 'provider'>;
  /** the tools the backend runs on, installed only on a provider it serves */
  tools: readonly ToolSpec[];
  /** the backend's helper library, sourced by setup and the boot hook */
  library: GuestAsset;
  /**
   * builds the steps that install every service environment.json records,
   * remove the backend's services it no longer records, and start the rest
   * @param context the family and the steps that must succeed first
   * @returns the steps
   */
  steps(context: ServiceStepContext): SetupStep[];
  /**
   * binds service control to a root session on the guest
   * @param session a root session open on the guest
   * @returns control of the backend's services
   */
  control(session: GuestSession): GuestServiceControl;
}
