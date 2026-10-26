import { matchesExitNode } from './tailscale/api';
import {
  assertSafeTailnetTarget,
  cleanupTailnetDevice,
  removeStaleTailnetDevice,
} from './tailscale/cleanup';
import { enrollTailscale } from './tailscale/enroll';
import { identifyTailnetDevice } from './tailscale/identity';
import {
  issueTailscaleCredential,
  preflightTailscale,
  verifyTailscaleExitNode,
} from './tailscale/preflight';
import { tailscaleReadiness } from './tailscale/readiness';
import { releaseTailscale } from './tailscale/release';
import { tailscaleDaemon, tailscaleLauncher } from './tailscale/service';
import { inspectTailscale } from './tailscale/status';
import { tailscaleTool } from './tailscale/tools';

import type { NetworkDriver } from '#application/ports/drivers';
import type { TailnetStatus } from '#domain/observations/network';

/** the Tailscale private-network driver */
export const tailscale: NetworkDriver<'tailscale', TailnetStatus> = {
  id: 'tailscale',
  kind: 'networks',
  displayName: 'Tailscale',
  supportsExitNode: true,
  tools: [tailscaleTool],
  inputs: {
    account: {
      environment: 'TAILSCALE_TAILNET',
      prompt:
        'Tailscale tailnet (API ID, .ts.net domain, or bare DNS subdomain)',
      flag: '--network-account ACCOUNT',
    },
    management: {
      environment: 'TAILSCALE_API_KEY',
      prompt: 'Tailscale management API key',
      flag: '--network-key-source env:NAME, file:PATH, or keychain:SERVICE/ACCOUNT',
      store: 'tailscale',
    },
    enrollment: {
      environment: 'TAILSCALE_AUTH_KEY',
      flag: '--network-auth-key-source SOURCE',
    },
    exitNode: {
      environment: 'TAILSCALE_EXIT_NODE',
      prompt: 'Home exit node',
      flag: '--exit-node NODE',
    },
  },
  daemon: tailscaleDaemon,
  launcher: tailscaleLauncher,
  preflight: preflightTailscale,
  verifyExitNode: verifyTailscaleExitNode,
  issueCredential: issueTailscaleCredential,
  enroll: enrollTailscale,
  release: releaseTailscale,
  status: inspectTailscale,
  matchesExitNode,
  readiness: tailscaleReadiness,
  identify: identifyTailnetDevice,
  assertSafeTarget: assertSafeTailnetTarget,
  cleanup: cleanupTailnetDevice,
  removeStaleDevice: removeStaleTailnetDevice,
};
