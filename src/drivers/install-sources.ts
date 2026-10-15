import type { NetworkComponent } from './component-types.js';

/** where a component's latest stable release is obtained */
export type InstallSource = NpmInstallSource | ReleaseInstallSource;

/** a package from the npm registry */
export interface NpmInstallSource {
  /** source discriminator */
  kind: 'npm';
  /** registry package name */
  package: string;
}

/** a release published to an upstream release feed */
export interface ReleaseInstallSource {
  /** source discriminator */
  kind: 'release';
  /** upstream release feed or repository identifier */
  feed: string;
  /** compiled guest module, contributed by the same driver, that installs a release from the feed */
  installer: string;
}

/** the installer helpers core lends a release installer, so the installer imports none of core's guest scripts */
export interface ReleaseInstallTools {
  /** stores a public release asset (url) as a file (name) in the private temporary directory */
  download: (url: string, name: string) => Promise<void>;
  /** reads public release metadata, returning the complete response text */
  downloadText: (url: string) => Promise<string>;
  /** replaces a managed symlink (path) to an installed target without following its existing target */
  link: (target: string, path: string) => Promise<void>;
  /** runs a root-controlled system tool, logging to the installer log, and returns its output when captured */
  run: (
    executable: string,
    args: string[],
    capture?: boolean,
  ) => Promise<string>;
  /** private directory the downloads land in */
  temporary: string;
  /** root-owned directory installed tools live in */
  toolsDirectory: string;
}

/** what the guest module named by `ReleaseInstallSource.installer` exports */
export interface ReleaseInstaller {
  /**
   * reads the network's feed for the latest stable release, so core can skip
   * an installation that is already at it
   * @param network the network as the guest recorded it
   * @param tools installer helpers core lends
   * @returns the latest stable version as a bare dotted version
   * @throws {Error} when the feed publishes no valid release; core then fails the network's component
   */
  latestRelease(
    network: NetworkComponent,
    tools: ReleaseInstallTools,
  ): Promise<string>;
  /**
   * installs the network's tool at a version its feed published; core calls
   * this only when the installed version differs from it
   * @param network the network as the guest recorded it
   * @param tools installer helpers core lends
   * @param version the version `latestRelease` returned
   */
  installRelease(
    network: NetworkComponent,
    tools: ReleaseInstallTools,
    version: string,
  ): Promise<void>;
}
