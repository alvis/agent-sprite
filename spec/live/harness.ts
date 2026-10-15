import { readFile } from 'node:fs/promises';

import { parse } from 'dotenv';

import { createLiveCleanup } from './cleanup.js';
import { createLiveCli } from './cli.js';
import { createFlyInventory, FLY_TOKEN_VARIABLE } from './fly.js';
import { ENVIRONMENT_PREFIX, LIVE_RUN_ID } from './identity.js';
import { createLiveProvider, isLiveProviderName } from './providers.js';
import { createRedactor } from './redaction.js';
import { connectTailnet } from './tailnet.js';

import type { LiveCleanup } from './cleanup.js';
import type { LiveCli } from './cli.js';
import type { LiveProvider, LiveProviderName } from './providers.js';
import type { Redactor } from './redaction.js';
import type { Tailnet } from './tailnet.js';

/** live run selection shared from global setup with every live spec */
export interface LiveRunConfiguration {
  /** installed packed executable */
  bin: string;
  /** absolute dotenv path holding the live credentials */
  envFile: string;
  /** provider selected for this run */
  provider: LiveProviderName;
  /** unique prefix owning every workstation of this run */
  runId: string;
  /** whether this invocation only sweeps an interrupted run */
  sweep: boolean;
}

/** run configuration plus what global setup decides for the project */
export interface LiveContext extends LiveRunConfiguration {
  /** isolated HOME shared by every CLI invocation of the run */
  home: string;
  /** whether the run is the Fly Machine probe, whose cleanup sweeps Fly apps too */
  fly: boolean;
}

/** everything a live spec needs to drive and clean up real workstations */
export interface LiveHarness {
  /** packed CLI driver */
  cli: LiveCli;
  /** selected provider adapter */
  provider: LiveProvider;
  /** tailnet holding workstation devices */
  tailnet: Tailnet;
  /** run-scoped cleanup */
  cleanup: LiveCleanup;
  /** removes dotenv values from captured output */
  redact: Redactor;
  /**
   * tells whether the live dotenv file supplies a non-empty value
   * @param name dotenv variable name
   * @returns true when set, without revealing the value
   */
  hasValue(name: string): boolean;
  /**
   * names a workstation inside the run prefix
   * @param suffix short role suffix
   * @returns workstation name
   */
  workstationName(suffix: string): string;
  /**
   * runs a body and always removes the workstation afterwards
   * @param name workstation created by the body
   * @param body test steps
   */
  withWorkstation(name: string, body: () => Promise<void>): Promise<void>;
}

declare module 'vitest' {
  /** values provided by spec/live/setup.ts */
  export interface ProvidedContext {
    live: LiveContext;
  }
}

/**
 * reads the live run selection exported by scripts/packed-cli.ts
 * @param environment process environment
 * @returns validated run configuration
 */
export function readLiveRunConfiguration(
  environment: NodeJS.ProcessEnv,
): LiveRunConfiguration {
  const read = (suffix: string): string => {
    const name = `${ENVIRONMENT_PREFIX}_${suffix}`;
    const value = environment[name];
    if (!value) {
      throw new Error(
        `${name} is required; run the live suite with pnpm test:live or pnpm test:live:fly`,
      );
    }

    return value;
  };
  const provider = read('LIVE_PROVIDER');
  const runId = read('LIVE_RUN_ID');
  if (!isLiveProviderName(provider)) {
    throw new Error(`Unsupported live provider ${provider}`);
  }
  if (!LIVE_RUN_ID.test(runId)) {
    throw new Error(`Malformed live run id ${runId}`);
  }

  return {
    bin: read('PACKED_BIN'),
    envFile: read('LIVE_ENV'),
    provider,
    runId,
    sweep: environment[`${ENVIRONMENT_PREFIX}_LIVE_SWEEP`] === '1',
  };
}

/**
 * builds the harness from the dotenv file without exposing its values
 * @param context run configuration and isolated home
 * @returns CLI, provider, tailnet and cleanup bound to the run
 */
export async function createLiveHarness(
  context: LiveContext,
): Promise<LiveHarness> {
  const values = parse(await readFile(context.envFile, 'utf8'));
  const requireValue = (name: string): string => {
    const value = values[name]?.trim();
    if (!value) {
      throw new Error(`${name} is required in the live dotenv file`);
    }

    return value;
  };
  const redact = createRedactor(values);
  const provider = createLiveProvider(context.provider, values);
  const tailnet = connectTailnet({
    apiKey: requireValue('TAILSCALE_API_KEY'),
    tailnet: requireValue('TAILSCALE_TAILNET'),
  });
  const cli = createLiveCli({
    bin: context.bin,
    envFile: context.envFile,
    home: context.home,
    redact,
  });
  const cleanup = createLiveCleanup({
    cli,
    provider,
    inventories: context.fly
      ? [createFlyInventory(requireValue(FLY_TOKEN_VARIABLE))]
      : [],
    tailnet,
    runId: context.runId,
    redact,
  });

  return {
    cli,
    provider,
    tailnet,
    cleanup,
    redact,
    hasValue: (name) => Boolean(values[name]?.trim()),
    workstationName: (suffix) => `${context.runId}-${suffix}`,
    async withWorkstation(name, body) {
      const failure = await body().then(
        () => undefined,
        (error: unknown) => ({ error }),
      );
      const cleanupFailure = await cleanup.remove(name).then(
        () => undefined,
        (error: unknown) => ({ error }),
      );
      if (failure && cleanupFailure) {
        throw new AggregateError(
          [failure.error, cleanupFailure.error],
          `${name} failed and its cleanup also failed`,
        );
      }
      const settled = failure ?? cleanupFailure;
      if (settled) {
        throw settled.error;
      }
    },
  };
}
