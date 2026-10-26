import { checkOperation } from '#kernel/operation';

import type { DriverRegistry } from '#application/ports/drivers';
import type { ProviderId } from '#domain/ids';
import type { PrerequisiteProblem } from '#domain/prerequisites';

/** a provider credential and where it was read from */
interface PreflightCredential {
  /** credential resolved from its declared sources, when found */
  token?: string;
  /** where the credential was read from */
  source?: string;
}

/** what a preflight asks of this computer */
interface PreflightHost {
  /**
   * runs a program on this computer
   * @param params program and arguments
   * @param params.program executable name
   * @param params.arguments program arguments
   * @returns the printed output
   */
  run(params: { program: string; arguments: string[] }): Promise<string>;
  /** looks tools up on this computer */
  tools: {
    /**
     * locates an executable without running it
     * @param name executable name
     * @returns the absolute path, or undefined when none has it
     */
    findTool(name: string): Promise<string | undefined>;
  };
}

/** registered providers and local host facilities for preflight */
interface ProviderPreflightDependencies {
  registry: Pick<DriverRegistry, 'providers'>;
  host: PreflightHost;
}

/**
 * runs a provider's preflight before its first provider call
 * @param dependencies what the preflight reads
 * @param dependencies.registry every registered driver
 * @param dependencies.host what the preflight asks of this computer
 * @param provider provider whose prerequisites are checked
 * @param credential management credential and the source it was read from
 * @returns every missing or misconfigured prerequisite with its fix
 */
export async function providerPreflight(
  dependencies: ProviderPreflightDependencies,
  provider: ProviderId,
  credential: PreflightCredential,
): Promise<PrerequisiteProblem[]> {
  const { registry, host } = dependencies;

  return registry.providers[provider].preflight({
    credential: credential.token,
    credentialSource: credential.source,
    findTool: async (name) => host.tools.findTool(name),
    readVersion: async (command, arguments_) =>
      host.run({ program: command, arguments: [...arguments_] }).catch(() => {
        checkOperation();

        return undefined;
      }),
  });
}
