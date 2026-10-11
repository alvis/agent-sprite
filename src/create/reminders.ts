import type { ResolvedInputs } from '#input/types';
import type { TailnetExitNode } from '#integrations/tailscale';

import type { CreatePreflight } from './types.js';

/**
 * distinguishes verified caller checks from readiness requiring the new guest
 * @param input resolved selections without serializing their credentials
 * @param exitNode caller-verified exit node, when management access is available
 * @returns non-secret checks and actionable reminders
 */
export function createPreflightSummary(
  input: ResolvedInputs,
  exitNode?: TailnetExitNode,
): CreatePreflight {
  return {
    checks: [
      'Required inputs and proxy URL syntax',
      'Sprites API authentication and target-name availability',
      ...(input.integrations.tailscale && input.tailscaleApiKey
        ? ['Tailnet access and hostname availability']
        : []),
      ...(exitNode
        ? ['Unique exit-node identity and approved IPv4 exit route']
        : []),
    ],
    reminders: [
      'Managed maintenance checks every 30 minutes; after seven days it updates tools and immediately restarts T3 and enabled Tailscale services.',
      ...(input.integrations.tailscale
        ? [
            'Guest TUN support, a writable native DNS mount and selected routing are verified before public exposure; failed readiness leaves the workstation private and incomplete.',
            'An enforced Sprite network policy blocks managed Tailscale DNS setup; no network policy is removed or bypassed.',
          ]
        : []),
      ...(input.integrations.tailscale && input.tailscaleAuthKey
        ? [
            'A supplied Tailscale enrolment key must remain valid through tool installation; use the management API key to mint a bounded key automatically when needed.',
          ]
        : []),
      ...(input.integrations.tailscale && !input.tailscaleApiKey
        ? [
            'Without TAILSCALE_API_KEY, caller-side tailnet and exit approval checks are unavailable; tailnet-device deletion needs separate management authorisation.',
          ]
        : []),
      ...(input.integrations.cliproxyapi
        ? [
            'CLIProxyAPI authentication, discovery and guest reachability are verified after routing setup; the hub must permit that network.',
          ]
        : [
            'Claude and Codex use native sign-in; configure their credentials on the guest before model work.',
          ]),
      ...(!input.githubToken
        ? [
            'Private GitHub access is not configured; supply GH_TOKEN or sign in with gh on the guest when needed.',
          ]
        : []),
      ...(!input.gitIdentity
        ? [
            'Git identity is not configured; supply an author name/email or configure native Git/Jujutsu settings before making commits.',
          ]
        : []),
    ],
  };
}
