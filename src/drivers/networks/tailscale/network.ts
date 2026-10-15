import { matchesExitNode } from './api.js';
import {
  cleanupTailnetDevice,
  assertSafeTailnetTarget,
  removeStaleTailnetDevice,
} from './cleanup.js';
import { enrollTailscale } from './enroll.js';
import { tailscaleGuestLeaf } from './guest-leaf.js';
import { identifyTailnetDevice } from './identity.js';
import {
  issueTailscaleCredential,
  preflightTailscale,
  verifyTailscaleExitNode,
} from './preflight.js';
import { tailscaleReadiness } from './readiness.js';
import { releaseTailscale } from './release.js';
import { tailscaleDaemon } from './service.js';
import { inspectTailscale } from './status.js';

import type { NetworkDriver } from '#drivers/contracts';

import type { TailnetStatus } from './types.js';

/** Tailscale as a private-network driver */
export const tailscale: NetworkDriver<'tailscale', TailnetStatus> = {
  id: 'tailscale',
  kind: 'networks',
  displayName: 'Tailscale',
  supportsExitNode: true,
  guest: tailscaleGuestLeaf.guest,
  tools: tailscaleGuestLeaf.tools,
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
