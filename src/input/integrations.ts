import { CommandFault } from '#errors';

import { readInputSources } from './sources.js';

import type { CommandOptions, Interaction } from '#command/contracts';

import type { GuestIntegrations } from '#integrations/guest/types';

import type { InputSources } from './sources.js';
import type { RequiredInput } from './types.js';

interface IntegrationChoiceContext {
  options: CommandOptions;
  sources: InputSources;
  interaction?: Interaction;
  defaults?: GuestIntegrations;
  inferFromInputs?: boolean;
  environmentScope?: IntegrationSelectionScope;
}

interface SetupIntegrationContext {
  options: CommandOptions;
  interaction?: Interaction;
  installed: GuestIntegrations;
  selectedSection?: 'all' | 'tailscale' | 'proxy';
}

interface BooleanChoiceContext {
  explicit?: boolean;
  sources: InputSources;
  name: string;
  inferred?: boolean;
  readEnvironment?: boolean;
}

interface IntegrationChoiceResolution {
  integrations: GuestIntegrations;
  problems: string[];
}

type IntegrationSelectionScope = 'all' | 'tailscale' | 'proxy' | 'none';

const DISABLED_INTEGRATIONS: GuestIntegrations = {
  tailscale: false,
  exitNode: false,
  cliproxyapi: false,
};

/**
 * resolves create integration choices before dependent credential prompts
 * @param options parsed tri-state options
 * @param interaction optional inline choice prompts
 * @returns effective choices and the already-read input sources
 */
export async function resolveCreateIntegrations(
  options: CommandOptions,
  interaction?: Interaction,
): Promise<IntegrationChoiceResolution & { sources: InputSources }> {
  const sources = await readInputSources(options);
  const resolution = await resolveIntegrationChoices({
    options,
    sources,
    interaction,
    inferFromInputs: !interaction || options.nonInteractive === true,
    environmentScope: 'all',
  });

  return { ...resolution, sources };
}

/**
 * resolves setup choices while preserving installed choices when omitted
 * @param context installed choices, selected section, and tri-state options
 * @returns effective integration selections for this setup run
 */
export async function resolveSetupIntegrations(
  context: SetupIntegrationContext,
): Promise<GuestIntegrations> {
  const { options, interaction, installed, selectedSection } = context;
  const sources = await readInputSources(options);
  const defaults: GuestIntegrations = {
    ...installed,
    tailscale:
      selectedSection === 'tailscale' && options.tailscale === undefined
        ? true
        : installed.tailscale,
    cliproxyapi:
      selectedSection === 'proxy' && options.proxy === undefined
        ? true
        : installed.cliproxyapi,
  };

  const resolution = await resolveIntegrationChoices({
    options,
    sources,
    interaction: selectedSection === 'all' ? interaction : undefined,
    defaults,
    environmentScope: selectedSection ?? 'none',
  });
  if (resolution.problems.length > 0) {
    throw new CommandFault({
      code: 'INPUT',
      message: resolution.problems.join(', '),
    });
  }

  return resolution.integrations;
}

/**
 * builds credential requirements for enabled direct integrations
 * @param integrations effective non-secret integration selections
 * @param base requirements independent of optional integrations
 * @param enrolled whether an existing Tailscale identity can be reused
 * @returns ordered requirements for aggregate preflight validation
 */
export function integrationRequirements(
  integrations: GuestIntegrations,
  base: readonly RequiredInput[] = [],
  enrolled = false,
): RequiredInput[] {
  return [
    ...base,
    ...(integrations.tailscale
      ? [
          ...(!enrolled ? (['tailscaleEnrollment'] as const) : []),
          'tailnet' as const,
          ...(integrations.exitNode ? (['exitNode'] as const) : []),
        ]
      : []),
    ...(integrations.cliproxyapi ? (['proxyUrl', 'proxyApiKey'] as const) : []),
  ];
}

/**
 * resolves tri-state flags, environment values, inference, and prompts
 * @param context choice sources and fallback selections
 * @returns effective non-secret integration choices
 */
async function resolveIntegrationChoices(
  context: IntegrationChoiceContext,
): Promise<IntegrationChoiceResolution> {
  const selectedTailscale = await resolveTailscaleChoice(context);
  const selectedExitNode = await resolveExitNodeChoice(
    context,
    selectedTailscale,
  );
  const selectedProxy = await resolveProxyChoice(context);

  return {
    integrations: {
      tailscale: selectedTailscale,
      exitNode: selectedExitNode,
      cliproxyapi: selectedProxy,
    },
    problems:
      selectedExitNode && !selectedTailscale
        ? [
            'Tailscale exit-node routing cannot be enabled while Tailscale is disabled',
          ]
        : [],
  };
}

/**
 * resolves the Tailscale selection from scoped sources and prompts
 * @param context choice sources and fallback selections
 * @returns effective Tailscale selection
 */
async function resolveTailscaleChoice(
  context: IntegrationChoiceContext,
): Promise<boolean> {
  const { options, sources, interaction } = context;
  const tailscale = resolveBooleanChoice({
    explicit: options.tailscale,
    sources,
    name: 'TAILSCALE_ENABLED',
    inferred:
      context.inferFromInputs && hasExplicitTailscaleInput(options, sources)
        ? true
        : undefined,
    readEnvironment:
      context.environmentScope === 'all' ||
      context.environmentScope === 'tailscale',
  });

  return (
    tailscale ??
    (interaction && !options.nonInteractive && !options.yes
      ? await interaction.confirm({
          message: 'Enable Tailscale?',
          defaultAnswer: context.defaults?.tailscale,
          description: context.defaults
            ? 'Enter keeps the installed selection; Y enables, N disables.'
            : 'Optional private-tailnet access. Default: disabled.',
        })
      : (context.defaults ?? DISABLED_INTEGRATIONS).tailscale)
  );
}

/**
 * resolves exit-node routing after the parent Tailscale choice
 * @param context choice sources and fallback selections
 * @param selectedTailscale effective parent integration choice
 * @returns effective exit-node selection
 */
async function resolveExitNodeChoice(
  context: IntegrationChoiceContext,
  selectedTailscale: boolean,
): Promise<boolean> {
  const { options, sources, interaction } = context;
  const useExitNode = resolveBooleanChoice({
    explicit: options.useExitNode,
    sources,
    name: 'TAILSCALE_EXIT_NODE_ENABLED',
    inferred:
      selectedTailscale &&
      context.inferFromInputs &&
      hasExplicitExitNodeInput(options, sources)
        ? true
        : undefined,
    readEnvironment:
      context.environmentScope === 'all' ||
      context.environmentScope === 'tailscale',
  });

  return selectedTailscale
    ? (useExitNode ??
        (interaction && !options.nonInteractive && !options.yes
          ? await interaction.confirm({
              message: 'Route through a Tailscale exit node?',
              defaultAnswer: context.defaults?.exitNode,
              description: context.defaults
                ? 'Enter keeps the installed exit-routing selection.'
                : 'Optional outbound routing through an approved exit node. Default: disabled.',
            })
          : (context.defaults ?? DISABLED_INTEGRATIONS).exitNode))
    : (useExitNode ?? false);
}

/**
 * resolves the CLIProxyAPI selection from scoped sources and prompts
 * @param context choice sources and fallback selections
 * @returns effective CLIProxyAPI selection
 */
async function resolveProxyChoice(
  context: IntegrationChoiceContext,
): Promise<boolean> {
  const { options, sources, interaction } = context;
  const cliproxyapi = resolveBooleanChoice({
    explicit: options.proxy,
    sources,
    name: 'CLIPROXYAPI_ENABLED',
    inferred:
      context.inferFromInputs && hasExplicitProxyInput(options, sources)
        ? true
        : undefined,
    readEnvironment:
      context.environmentScope === 'all' ||
      context.environmentScope === 'proxy',
  });

  return (
    cliproxyapi ??
    (interaction && !options.nonInteractive && !options.yes
      ? await interaction.confirm({
          message: 'Enable CLIProxyAPI?',
          defaultAnswer: context.defaults?.cliproxyapi,
          description: context.defaults
            ? 'Enter keeps the installed selection; N restores native harness authentication.'
            : 'Optional Claude/Codex routing to your existing hub. Default: disabled.',
        })
      : (context.defaults ?? DISABLED_INTEGRATIONS).cliproxyapi)
  );
}

/**
 * parses one explicit or environment-backed tri-state choice
 * @param context explicit, sourced, and inferred values
 * @returns the selected boolean or undefined when unresolved
 */
function resolveBooleanChoice(
  context: BooleanChoiceContext,
): boolean | undefined {
  const { explicit, sources, name, inferred, readEnvironment = true } = context;
  if (explicit !== undefined) {
    return explicit;
  }
  const raw = readEnvironment
    ? firstNonblankValue([sources.processEnv[name], sources.fileEnv[name]])
    : undefined;
  if (raw === undefined) {
    return inferred;
  }
  if (/^(?:1|true|yes|on)$/i.test(raw)) {
    return true;
  }
  if (/^(?:0|false|no|off)$/i.test(raw)) {
    return false;
  }
  throw new CommandFault({
    code: 'INPUT',
    message: `${name} must be a boolean value`,
  });
}

/**
 * detects caller-supplied Tailscale values that imply enablement
 * @param options parsed explicit values
 * @param sources process and dotenv values
 * @returns whether a direct Tailscale input was supplied
 */
function hasExplicitTailscaleInput(
  options: CommandOptions,
  sources: InputSources,
): boolean {
  return hasNonblankValue([
    options.tailnet,
    options.exitNode,
    options.tailscaleApiKeySource,
    options.tailscaleAuthKeySource,
    sources.processEnv.TAILSCALE_TAILNET,
    sources.processEnv.TAILSCALE_EXIT_NODE,
    sources.processEnv.TAILSCALE_API_KEY,
    sources.processEnv.TAILSCALE_AUTH_KEY,
    sources.fileEnv.TAILSCALE_TAILNET,
    sources.fileEnv.TAILSCALE_EXIT_NODE,
    sources.fileEnv.TAILSCALE_API_KEY,
    sources.fileEnv.TAILSCALE_AUTH_KEY,
  ]);
}

/**
 * detects caller-supplied exit-node identity that implies routing
 * @param options parsed explicit values
 * @param sources process and dotenv values
 * @returns whether an exit-node identity was supplied
 */
function hasExplicitExitNodeInput(
  options: CommandOptions,
  sources: InputSources,
): boolean {
  return hasNonblankValue([
    options.exitNode,
    sources.processEnv.TAILSCALE_EXIT_NODE,
    sources.fileEnv.TAILSCALE_EXIT_NODE,
  ]);
}

/**
 * detects caller-supplied proxy values that imply enablement
 * @param options parsed explicit values
 * @param sources process and dotenv values
 * @returns whether a direct proxy input was supplied
 */
function hasExplicitProxyInput(
  options: CommandOptions,
  sources: InputSources,
): boolean {
  return hasNonblankValue([
    options.proxyUrl,
    options.proxyApiKeySource,
    sources.processEnv.CLIPROXYAPI_BASE_URL,
    sources.processEnv.CLIPROXYAPI_API_KEY,
    sources.fileEnv.CLIPROXYAPI_BASE_URL,
    sources.fileEnv.CLIPROXYAPI_API_KEY,
  ]);
}

/**
 * detects any caller value containing non-whitespace text
 * @param values candidate direct input values
 * @returns whether at least one supplied value is nonblank
 */
function hasNonblankValue(values: Array<string | undefined>): boolean {
  return firstNonblankValue(values) !== undefined;
}

/**
 * selects the first nonblank caller value and normalizes surrounding whitespace
 * @param values candidate direct input values
 * @returns the first trimmed value or undefined
 */
function firstNonblankValue(
  values: Array<string | undefined>,
): string | undefined {
  return values.map((value) => value?.trim()).find((value) => Boolean(value));
}
