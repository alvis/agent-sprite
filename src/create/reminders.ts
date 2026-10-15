import { catalog } from '#core/catalog';
import { harnessLabel } from '#core/harnesses';
import { networkDriver } from '#core/networks';

import type { NetworkExitNode } from '#drivers/contracts';
import type { ResolvedInputs } from '#input/types';

import type { CreatePreflight } from './types.js';

/**
 * distinguishes verified caller checks from readiness requiring the new guest
 * @param input resolved selections without serializing their credentials
 * @param exitNode caller-verified exit node, when management access is available
 * @returns non-secret checks and actionable reminders
 */
export function createPreflightSummary(
  input: ResolvedInputs,
  exitNode?: NetworkExitNode,
): CreatePreflight {
  const { profile } = input;
  const network = networkDriver(profile.network);
  const provider = catalog.providers[profile.provider].displayName;

  return {
    checks: [
      'Required inputs and proxy URL syntax',
      `${provider} prerequisites, authentication and target-name availability`,
      ...(network.daemon && input.networkKey
        ? [`${network.displayName} access and hostname availability`]
        : []),
      ...(exitNode
        ? ['Unique exit-node identity and approved IPv4 exit route']
        : []),
    ],
    reminders: [
      `Managed maintenance checks every 30 minutes; after seven days it installs the latest tools in place without restarting ${catalog.agents[profile.agent].displayName} or any other service.`,
      ...networkReminders(input),
      ...(profile.options.isProxyEnabled
        ? [
            'CLIProxyAPI authentication, discovery and guest reachability are verified after routing setup; the hub must permit that network.',
          ]
        : [
            `${profile.harnesses.map((id) => harnessLabel(id)).join(' and ')} use native sign-in; configure their credentials on the guest before model work.`,
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

/**
 * describes what the selected network still verifies on the new guest
 * @param input resolved selection and network credentials
 * @returns reminders for the selected network, none without one
 */
function networkReminders(input: ResolvedInputs): string[] {
  const network = networkDriver(input.profile.network);
  if (!network.inputs) {
    return [];
  }
  const { displayName: name, inputs } = network;

  return [
    'Guest TUN support, a writable native DNS mount and selected routing are verified before public exposure; failed readiness leaves the workstation private and incomplete.',
    `A provider network policy that blocks managed ${name} DNS setup is reported, never removed or bypassed.`,
    ...(input.enrollmentKey
      ? [
          `A supplied ${name} enrolment key must remain valid through tool installation; use the management API key to mint a bounded key automatically when needed.`,
        ]
      : []),
    ...(input.networkKey
      ? []
      : [
          `Without ${inputs.management.environment}, caller-side ${name} account and exit approval checks are unavailable; device deletion needs separate management authorisation.`,
        ]),
  ];
}
