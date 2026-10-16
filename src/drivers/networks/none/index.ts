import type {
  NetworkCleanup,
  NetworkDriver,
  NetworkStatus,
  ReadinessFinding,
} from '#drivers/contracts';

/** why the workstation reports no network, and why it cannot use one */
const NOT_SELECTED = 'No private network is selected';

/**
 * reports the status of a workstation that joins no private network
 * @returns a neutral status that is offline and skipped
 */
function notConnected(): NetworkStatus {
  return { online: false, skipped: true, reason: NOT_SELECTED };
}

/**
 * keeps the workstation off any private network: it installs nothing, runs no
 * daemon, takes no inputs, and every action leaves the guest and the caller's
 * network accounts untouched
 */
export const none: NetworkDriver<'none'> = {
  id: 'none',
  kind: 'networks',
  displayName: 'None',
  supportsExitNode: false,
  tools: [],
  preflight: async () => Promise.resolve({ problems: [] }),
  verifyExitNode: async () => Promise.reject(new Error(NOT_SELECTED)),
  issueCredential: async () => Promise.reject(new Error(NOT_SELECTED)),
  enroll: async () => Promise.resolve(),
  release: async () => Promise.resolve(),
  status: async () => Promise.resolve(notConnected()),
  matchesExitNode: () => false,
  readiness: (): ReadinessFinding[] => [
    { name: 'private network', status: 'skipped' },
  ],
  identify: async () => Promise.resolve(notConnected()),
  assertSafeTarget: async () => Promise.resolve(),
  cleanup: async (): Promise<NetworkCleanup> =>
    Promise.resolve({ ok: true, status: 'no device identity recorded' }),
};
