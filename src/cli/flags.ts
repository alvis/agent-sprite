import { buildChoiceParser } from '@stricli/core';

import { harnessIds } from '#core/harnesses';
import { agentIds, providerIds, releaseChannelIds } from '#core/ids';
import { networkIds } from '#core/networks';

import { machineFlags } from './machine-flags';
import { parseWholeNumber } from './whole-number';

/** local provider credential selection shared by every operation */
export const providerCredentialFlags = {
  envFile: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'FILE',
    brief: 'FILE · explicit env file',
  },
  providerTokenSource: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'SOURCE',
    brief:
      'SOURCE · provider management credential source reference, for the provider --provider selects (sprite when omitted)',
  },
  localCredentials: {
    kind: 'boolean',
    optional: true,
    withNegated: true,
    brief: 'enable or disable saved credentials',
  },
} as const;

/** output and automation controls shared by every operation */
export const outputFlags = {
  json: { kind: 'boolean', default: false, brief: 'print one JSON result' },
  color: {
    kind: 'boolean',
    optional: true,
    withNegated: true,
    brief: 'enable or disable color',
  },
  verbose: { kind: 'boolean', default: false, brief: 'show detailed status' },
  quiet: {
    kind: 'boolean',
    default: false,
    brief: 'hide routine status and progress',
  },
  nonInteractive: { kind: 'boolean', default: false, brief: 'disable prompts' },
} as const;

/** complete controls for read-only and shared workstation operations */
export const commonFlags = {
  ...providerCredentialFlags,
  ...outputFlags,
} as const;

/** consent for selected create, setup, and terminate actions */
export const consentFlags = {
  yes: {
    kind: 'boolean',
    default: false,
    brief: 'confirm already selected actions',
  },
} as const;

/** network identity and routing inputs also used for deletion cleanup */
export const networkSelectionFlags = {
  exitNode: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'NODE',
    brief: 'NODE · home exit node',
  },
  networkAccount: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'ACCOUNT',
    brief: 'ACCOUNT · account or network the network key manages',
  },
} as const;

/** selected network management credential source */
export const networkCredentialFlags = {
  networkKeySource: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'SOURCE',
    brief: 'SOURCE · network management key source reference',
  },
} as const;

/** explicit pairing action, separate from ordinary integration choices */
export const pairingFlags = {
  withPairCode: {
    kind: 'boolean',
    optional: true,
    withNegated: false,
    brief:
      'create and display a pairing code in the agent URL (5 minutes); alias --with-<agent>-pair-code',
  },
} as const;

/** provider choice, which commands on an existing workstation also accept to skip the search across providers */
export const providerFlags = {
  provider: {
    kind: 'parsed',
    parse: buildChoiceParser(providerIds()),
    optional: true,
    placeholder: 'PROVIDER',
    brief: `PROVIDER · ${providerIds().join(', ')}`,
  },
} as const;

/** driver and option selection, in the order interactive setup asks for it */
export const selectionFlags = {
  ...providerFlags,
  ...machineFlags,
  agent: {
    kind: 'parsed',
    parse: buildChoiceParser(agentIds()),
    optional: true,
    placeholder: 'AGENT',
    brief: `AGENT · ACP agent: ${agentIds().join(', ')}`,
  },
  release: {
    kind: 'parsed',
    parse: buildChoiceParser(releaseChannelIds()),
    optional: true,
    placeholder: 'CHANNEL',
    brief: `CHANNEL · ACP agent release channel: ${releaseChannelIds().join(', ')}; the agent's default when omitted`,
  },
  harness: {
    kind: 'parsed',
    parse: buildChoiceParser(harnessIds()),
    optional: true,
    variadic: true,
    placeholder: 'HARNESS',
    brief: `HARNESS · ${harnessIds().join(', ')} (repeatable)`,
  },
  network: {
    kind: 'parsed',
    parse: buildChoiceParser(networkIds()),
    optional: true,
    placeholder: 'NETWORK',
    brief: `NETWORK · ${networkIds().join(', ')}`,
  },
  idleMinutes: {
    kind: 'parsed',
    parse: parseWholeNumber,
    optional: true,
    placeholder: 'MINUTES',
    brief: 'MINUTES · suspend after idle; 0 never suspends (default 5)',
  },
  holdMaxMinutes: {
    kind: 'parsed',
    parse: parseWholeNumber,
    optional: true,
    placeholder: 'MINUTES',
    brief: 'MINUTES · turn-hold lifetime after its last refresh (default 60)',
  },
  updateDueDays: {
    kind: 'parsed',
    parse: parseWholeNumber,
    optional: true,
    placeholder: 'DAYS',
    brief:
      'DAYS · after the last successful update before another is due, at least 1 (default 1)',
  },
} as const;

/** non-secret provision and setup integration choices */
export const integrationFlags = {
  proxy: {
    kind: 'boolean',
    optional: true,
    withNegated: true,
    brief: 'enable or disable CLIProxyAPI routing',
  },
  useExitNode: {
    kind: 'boolean',
    optional: true,
    withNegated: true,
    brief: 'enable or disable exit-node routing on the selected network',
  },
  github: {
    kind: 'boolean',
    optional: true,
    withNegated: true,
    brief: 'enable or disable GitHub access',
  },
  gitIdentity: {
    kind: 'boolean',
    optional: true,
    withNegated: true,
    brief: 'enable or disable Git/JJ identity',
  },
  proxyUrl: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'URL',
    brief: 'URL · existing CLIProxyAPI hub URL',
  },
  gitName: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'NAME',
    brief: 'NAME · Git author name',
  },
  gitEmail: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'EMAIL',
    brief: 'EMAIL · Git author email',
  },
  gitCommitterName: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'NAME',
    brief: 'NAME · Git committer name',
  },
  gitCommitterEmail: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'EMAIL',
    brief: 'EMAIL · Git committer email',
  },
  githubHost: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'HOST',
    brief: 'HOST · GitHub host',
  },
  ...networkSelectionFlags,
} as const;

/** credential source references for selected integrations */
export const integrationCredentialFlags = {
  networkAuthKeySource: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'SOURCE',
    brief: 'SOURCE · single-use network enrollment key source reference',
  },
  proxyApiKeySource: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'SOURCE',
    brief: 'SOURCE · hub client key source reference',
  },
  githubTokenSource: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'SOURCE',
    brief: 'SOURCE · GitHub token source reference',
  },
} as const;

/** optional native plugin and marketplace selections; per-harness flags come from harness-flags */
export const pluginFlags = {
  plugins: {
    kind: 'boolean',
    optional: true,
    withNegated: true,
    brief: 'enable or disable plugins',
  },
  reuseMarketplaces: {
    kind: 'boolean',
    default: false,
    brief: 'reuse the first harness marketplace sources for the others once',
  },
} as const;

/** setup-only action selectors */
export const setupFlags = {
  section: {
    kind: 'parsed',
    parse: buildChoiceParser([
      'all',
      'agent',
      'network',
      'github',
      'git',
      'proxy',
      'env',
      'plugins',
      'tools',
    ] as const),
    optional: true,
    placeholder: 'SECTION',
    brief:
      'SECTION · all, agent, network, github, git, proxy, env, plugins, or tools',
  },
  pluginHarness: {
    kind: 'parsed',
    parse: buildChoiceParser(harnessIds()),
    optional: true,
    placeholder: 'HARNESS',
    brief: `HARNESS · plugin harness: ${harnessIds().join(', ')}`,
  },
  update: { kind: 'boolean', default: false, brief: 'update managed tools' },
} as const;
