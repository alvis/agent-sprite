import { buildChoiceParser } from '@stricli/core';

/** local provider credential selection shared by every operation */
export const providerCredentialFlags = {
  env: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'FILE',
    brief: 'FILE · explicit env file',
  },
  spritesTokenSource: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'SOURCE',
    brief: 'SOURCE · Sprites token source reference',
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

/** tailnet identity and routing inputs also used for deletion cleanup */
export const tailnetSelectionFlags = {
  exitNode: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'NODE',
    brief: 'NODE · home exit node',
  },
  tailnet: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'TAILNET',
    brief: 'TAILNET · Tailscale API ID, DNS domain, or subdomain',
  },
} as const;

/** selected Tailscale management credential source */
export const tailnetCredentialFlags = {
  tailscaleApiKeySource: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'SOURCE',
    brief: 'SOURCE · Tailscale API key source reference',
  },
} as const;

/** explicit pairing action, separate from ordinary integration choices */
export const pairingFlags = {
  withT3PairCode: {
    kind: 'boolean',
    optional: true,
    withNegated: false,
    brief: 'create and display a pairing code in the T3 URL (5 minutes)',
  },
} as const;

/** non-secret provision and setup integration choices */
export const integrationFlags = {
  tailscale: {
    kind: 'boolean',
    optional: true,
    withNegated: true,
    brief: 'enable or disable managed Tailscale',
  },
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
    brief: 'enable or disable Tailscale exit-node routing',
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
  ...tailnetSelectionFlags,
} as const;

/** credential source references for selected integrations */
export const integrationCredentialFlags = {
  tailscaleAuthKeySource: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'SOURCE',
    brief: 'SOURCE · Tailscale auth key source reference',
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

/** optional native plugin and marketplace selections */
export const pluginFlags = {
  plugins: {
    kind: 'boolean',
    optional: true,
    withNegated: true,
    brief: 'enable or disable plugins',
  },
  claudePlugins: {
    kind: 'boolean',
    optional: true,
    withNegated: true,
    brief: 'enable or disable Claude plugins',
  },
  codexPlugins: {
    kind: 'boolean',
    optional: true,
    withNegated: true,
    brief: 'enable or disable Codex plugins',
  },
  claudeMarketplace: {
    kind: 'parsed',
    parse: String,
    optional: true,
    variadic: true,
    placeholder: 'SOURCE',
    brief: 'SOURCE · Claude marketplace source (repeatable)',
  },
  codexMarketplace: {
    kind: 'parsed',
    parse: String,
    optional: true,
    variadic: true,
    placeholder: 'SOURCE',
    brief: 'SOURCE · Codex marketplace source (repeatable)',
  },
  claudePlugin: {
    kind: 'parsed',
    parse: String,
    optional: true,
    variadic: true,
    placeholder: 'PLUGIN',
    brief: 'PLUGIN · Claude plugin (repeatable)',
  },
  codexPlugin: {
    kind: 'parsed',
    parse: String,
    optional: true,
    variadic: true,
    placeholder: 'PLUGIN',
    brief: 'PLUGIN · Codex plugin (repeatable)',
  },
  reuseClaudeMarketplaces: {
    kind: 'boolean',
    default: false,
    brief: 'reuse Claude marketplace sources for Codex once',
  },
} as const;

/**
 * defines a repeatable native plugin value with its visible help label
 * @param placeholder value kind shown in help
 * @param description action associated with each supplied value
 * @returns typed parsed flag metadata
 */
function repeatableFlag(
  placeholder: 'SOURCE' | 'PLUGIN',
  description: string,
): {
  kind: 'parsed';
  parse: StringConstructor;
  optional: true;
  variadic: true;
  placeholder: 'SOURCE' | 'PLUGIN';
  brief: string;
} {
  return {
    kind: 'parsed',
    parse: String,
    optional: true,
    variadic: true,
    placeholder,
    brief: `${placeholder} · ${description}`,
  } as const;
}

/** explicit setup-only native plugin removals and deactivation */
export const pluginChangeFlags = {
  removeClaudeMarketplace: repeatableFlag(
    'SOURCE',
    'remove Claude marketplace',
  ),
  removeCodexMarketplace: repeatableFlag('SOURCE', 'remove Codex marketplace'),
  disableClaudePlugin: repeatableFlag('PLUGIN', 'disable Claude plugin'),
  disableCodexPlugin: repeatableFlag('PLUGIN', 'disable Codex plugin'),
  uninstallClaudePlugin: repeatableFlag('PLUGIN', 'uninstall Claude plugin'),
  uninstallCodexPlugin: repeatableFlag('PLUGIN', 'uninstall Codex plugin'),
} as const;

/** setup-only action selectors */
export const setupFlags = {
  section: {
    kind: 'parsed',
    parse: buildChoiceParser([
      'all',
      't3',
      'tailscale',
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
      'SECTION · all, t3, tailscale, github, git, proxy, env, plugins, or tools',
  },
  harness: {
    kind: 'parsed',
    parse: buildChoiceParser(['claude', 'codex'] as const),
    optional: true,
    placeholder: 'HARNESS',
    brief: 'HARNESS · Claude or Codex plugin harness',
  },
  update: { kind: 'boolean', default: false, brief: 'update managed tools' },
} as const;
