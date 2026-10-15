// guest kernel: constants only, so host code may import it (REQ-MAINT-5)

import { GUEST_ROOT } from './guest-root.js';
import { TOOL_LINK_DIRECTORY } from './homebrew.js';

/**
 * the Google Chrome install on a workstation. Neither Homebrew on Linux nor
 * npm carries it, and installing it with dpkg from Google's apt repository
 * would record a package whose source a Fly cold boot no longer knows, so the
 * stable package from that repository is unpacked, unchanged, under the guest
 * root, which a provider that keeps the root filesystem only until a cold boot
 * keeps on its volume; its libraries come from the distro, and the command is
 * linked where agent-browser looks for a system Chrome
 */
export const CHROME = {
  /** key of the install outcome and of the recorded version */
  component: 'google-chrome',
  /** the apt repository Google publishes the stable package in, for amd64 and arm64 */
  repository: 'https://dl.google.com/linux/chrome/deb/',
  /** the package that follows Chrome's stable channel */
  package: 'google-chrome-stable',
  /** root-owned directory holding one unpacked package per version */
  directory: `${GUEST_ROOT}/tools/google-chrome`,
  /** the launcher inside an unpacked package, which finds the browser beside itself */
  launcher: 'opt/google/chrome/google-chrome',
  /** the linked command, the first name agent-browser looks for on `PATH` */
  command: `${TOOL_LINK_DIRECTORY}/google-chrome`,
} as const;
