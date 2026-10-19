import { matchesExitNode } from './api';
import {
  cleanupTailnetDevice,
  assertSafeTailnetTarget,
  removeStaleTailnetDevice,
} from './cleanup';
import { enrollTailscale } from './enroll';
import { identifyTailnetDevice } from './identity';
import {
  issueTailscaleCredential,
  preflightTailscale,
  verifyTailscaleExitNode,
} from './preflight';
import { tailscaleReadiness } from './readiness';
import { releaseTailscale } from './release';
import { tailscaleDaemon, tailscaleLauncher } from './service';
import { inspectTailscale } from './status';
import { tailscaleTool } from './tools';

import type { NetworkDriver } from '#application/ports/drivers';

import type { TailnetStatus } from '#domain/observations/network';

/** Tailscale as a private-network driver */
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
