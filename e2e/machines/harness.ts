import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { inject } from 'vitest';

import { createMachineCleanup } from './cleanup';
import { createMachineCli, driverConfigHome } from './cli';
import { TEST_PREFIX } from './identity';
import { createMachineProvider, credentialVariable } from './providers';
import { createRedactor } from './redaction';
import { connectTailnet } from './tailnet';

import type { MachineCleanup } from './cleanup';
import type { MachineCli } from './cli';
import type { MachineProvider, MachineType } from './providers';
import type { Redactor } from './redaction';
import type { Tailnet } from './tailnet';

/** everything a machine spec needs to drive and clean up real workstations */
export interface MachineHarness {
  /** this run's id, the prefix of every workstation name it creates */
  runId: string;
  /** the run's isolated home, below which every CLI home and run file lives */
  runHome: string;
  /** packed CLI driver sharing the run's home */
  cli: MachineCli;
  /** the machine type's provider adapter */
  provider: MachineProvider;
  /** tailnet holding workstation devices */
  tailnet: Tailnet;
  /** cleanup scoped to this run */
  cleanup: MachineCleanup;
  /** removes `TEST_*` values from captured output */
  redact: Redactor;
  /**
   * tells whether the run supplies a non-empty `TEST_*` value
   * @param name variable name without its `TEST_` prefix, as the CLI reads it
   * @returns true when set, without revealing the value
   */
  hasValue(name: string): boolean;
  /**
   * builds a CLI driver with a home of its own below the run's home. flyctl's
   * SSH agent is shared by every process of one home and stopped by the first
   * of them to finish, so scenarios that run side by side must not share one
   * @param tag short name of the home; homes stay short for socket paths
   * @returns CLI driver bound to that home
   */
  isolatedCli(tag: string): Promise<MachineCli>;
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

const PREFLIGHT_TIMEOUT_MS = 2 * 60_000;

/**
 * builds the harness of one machine type from the values e2e/setup.ts
 * provides and the `TEST_*` credentials, without exposing their values
 * @param type machine type the spec file drives
 * @returns CLI, provider, tailnet and cleanup bound to the run
 * @throws {Error} with the CLI's own preflight failure when the type's
 * credential is missing, so the spec file fails rather than skips
 */
export async function createMachineHarness(
  type: MachineType,
): Promise<MachineHarness> {
  const bin = inject('packedBin');
  const runId = inject('runId');
  const home = inject('runHome');
  // the product's drivers this worker imports keep their flyctl state below it
  if (process.env.XDG_CONFIG_HOME !== driverConfigHome(home)) {
    throw new Error(
      "XDG_CONFIG_HOME is not the run's driver home; e2e/setup.ts sets it before any worker starts",
    );
  }
  const redact = createRedactor(process.env);
  const cli = createMachineCli({ bin, home, redact });
  const read = (name: string): string =>
    process.env[`${TEST_PREFIX}${name}`]?.trim() ?? '';

  const token = process.env[credentialVariable(type)]?.trim() ?? '';
  if (token === '') {
    await failPreflight(cli, { type, runId });
  }
  const requireValue = (name: string): string => {
    const value = read(name);
    if (!value) {
      throw new Error(
        `${TEST_PREFIX}${name} is required for the machine specs`,
      );
    }

    return value;
  };
  const provider = createMachineProvider(type, { token, redact });
  const tailnet = connectTailnet({
    apiKey: requireValue('TAILSCALE_API_KEY'),
    tailnet: requireValue('TAILSCALE_TAILNET'),
  });
  const cleanup = createMachineCleanup({
    cli,
    inventories: [provider],
    tailnet,
    scope: `${runId}-`,
    redact,
  });

  return {
    runId,
    runHome: home,
    cli,
    provider,
    tailnet,
    cleanup,
    redact,
    hasValue: (name) => read(name) !== '',
    async isolatedCli(tag) {
      const isolated = join(home, tag);
      await mkdir(isolated, { recursive: true });

      return createMachineCli({ bin, home: isolated, redact });
    },
    workstationName: (suffix) => `${runId}-${suffix}`,
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

/**
 * runs a read-only CLI command on the machine type without its credential
 * and fails with the CLI's own preflight message, which it gives before any
 * provider call
 * @param cli CLI driver of the run
 * @param probe machine type and run whose name the probe looks up
 * @param probe.type machine type the spec file drives
 * @param probe.runId run whose prefix the looked-up name carries
 * @returns never
 * @throws {Error} always
 */
async function failPreflight(
  cli: MachineCli,
  probe: { type: MachineType; runId: string },
): Promise<never> {
  const { envelope } = await cli.json(
    ['show', `${probe.runId}-preflight`, '--provider', probe.type],
    PREFLIGHT_TIMEOUT_MS,
  );
  const reason = envelope.error
    ? [envelope.error.message, ...(envelope.error.details ?? [])].join('\n')
    : `show succeeded without ${credentialVariable(probe.type)}`;

  throw new Error(`${probe.type} e2e cannot run: ${reason}`);
}
