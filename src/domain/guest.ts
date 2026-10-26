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
  /** OA_* variables its owner adds to the layout header, such as a provider's own paths */
  variables?: Readonly<Record<string, string>>;
}

/** the outcome of asking a family whether a release can run Homebrew */
export type HomebrewSupport =
  | {
      /** release runs Homebrew */
      supported: true;
      /** system packages Homebrew needs before its installer runs */
      prerequisites: readonly string[];
    }
  | {
      /** release cannot run Homebrew */
      supported: false;
      /** why, as reported to the user */
      reason: string;
    };

/** who runs the guest services: the provider itself, or a backend setup installs */
export type ServiceBackendId = 'provider' | 'runit';
