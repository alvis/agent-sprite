/** Existing create and setup ordering, including their distinct environment placement. */
export type NativeConfigurationStep =
  | 'tools'
  | 'tailscale'
  | 'assert'
  | 'environment'
  | 'github'
  | 'git'
  | 'proxy'
  | 'plugins'
  | 'services';

/** Keep the create guest transaction confined to configuration, never prompts or services. */
export interface NativeConfigurationSteps {
  preparation: readonly NativeConfigurationStep[];
  configuration: readonly NativeConfigurationStep[];
  completion: readonly NativeConfigurationStep[];
}

/**
 * Select the already-observable order for creation or full setup/recovery.
 * @param context selected workflow and installation state
 * @param context.mode create or setup workflow
 * @param context.initialInstallation whether setup must install tools first
 * @returns ordered preparation, configuration, and completion steps
 */
export function nativeConfigurationSteps(context: {
  mode: 'create' | 'setup';
  initialInstallation?: boolean;
}): NativeConfigurationSteps {
  if (context.mode === 'create') {
    return {
      preparation: ['tools', 'tailscale'],
      configuration: [
        'assert',
        'environment',
        'github',
        'git',
        'proxy',
        'plugins',
      ],
      completion: ['services'],
    };
  }

  return {
    preparation: context.initialInstallation
      ? ['tools', 'tailscale']
      : ['tailscale', 'tools'],
    configuration: ['github', 'git', 'proxy', 'environment', 'plugins'],
    completion: ['services'],
  };
}

/**
 * Execute selected steps in order while callers retain their transaction boundary.
 * @param steps selected ordered steps
 * @param handlers workflow-specific implementation for each selected step
 */
export async function runNativeConfigurationSteps(
  steps: readonly NativeConfigurationStep[],
  handlers: Partial<Record<NativeConfigurationStep, () => Promise<void>>>,
): Promise<void> {
  for (const step of steps) {
    const handler = handlers[step];
    if (!handler) {
      throw new Error(`Missing native configuration handler for ${step}`);
    }
    await handler();
  }
}
