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

import type { NetworkDriver } from '#drivers/networks/contracts';

import type { TailnetStatus } from './types';

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
    },
    management: {
      environment: 'TAILSCALE_API_KEY',
      prompt: 'Tailscale management API key',
      store: 'tailscale',
    },
    enrollment: { environment: 'TAILSCALE_AUTH_KEY' },
    exitNode: { environment: 'TAILSCALE_EXIT_NODE', prompt: 'Home exit node' },
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
