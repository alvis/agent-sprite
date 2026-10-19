import type { GuestServiceControl } from '#application/ports/guest-channel';
import type { SetupStep } from '#application/ports/plan';
import type { GuestSession } from '#application/ports/session';
import type {
  GuestAsset,
  HomebrewSupport,
  OsFamilyId,
  OsRelease,
  ServiceBackendId,
} from '#domain/guest';
import type { ToolOwner, ToolSpec } from '#domain/tools';

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
