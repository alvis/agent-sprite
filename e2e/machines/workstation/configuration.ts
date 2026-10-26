import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RUNTIME_ENV_PATH } from '#adapters/guest/platform/layout';

import { successData } from '../cli';
import { asRoot } from '../guest';
import { foreignIdentifiers } from '../ownership';

import {
  CREATE_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  DEVICE_TIMEOUT_MS,
  DEVICE_POLL_MS,
} from './limits';

import type { MachineHarness } from '../harness';

import type { VariantContext, WorkstationCaseContext } from './context';

const GIT_NAME = 'Open Agent E2E';
const GIT_EMAIL = 'e2e@example.invalid';
const RUNTIME_PROBE = { E2E_RUNTIME_PROBE: 'forwarded' };
const PROXY_REQUIRED = ['CLIPROXYAPI_BASE_URL', 'CLIPROXYAPI_API_KEY'];
const GITHUB_UNSET = ['GH_TOKEN', 'GITHUB_TOKEN'];

/**
 * proves configured proxy, identity and runtime environment installation
 * @param harness scoped provider, CLI and cleanup
 * @param context concurrent Vitest assertion and cancellation context
 */
export async function runConfiguredScenario(
  harness: MachineHarness,
  context: WorkstationCaseContext,
): Promise<void> {
  const name = harness.workstationName('i');
  const cli = await harness.isolatedCli('i');
  const run = {
    harness,
    cli,
    name,
    expect: context.expect,
    signal: context.signal,
    annotate: context.annotate,
  };
  const mismatched = [
    ...PROXY_REQUIRED.filter((key) => !harness.hasValue(key)),
    ...GITHUB_UNSET.filter((key) => harness.hasValue(key)),
  ];
  if (mismatched.length > 0) {
    throw new Error(
      `This create needs ${PROXY_REQUIRED.join(', ')} set and ` +
        `${GITHUB_UNSET.join(', ')} empty; mismatched: ${mismatched.join(', ')}`,
    );
  }

  // a non-secret file, so only its names, never a credential, reach the guest
  const envFile = join(harness.runHome, `${name}.env`);
  await writeFile(
    envFile,
    Object.entries(RUNTIME_PROBE)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );

  await harness.withWorkstation(name, async () => {
    await createConfigured(run, envFile);
    await checkConfigured(run);
  });
}

/**
 * creates a workstation with proxy, identity and env file
 * @param context run drivers and test assertions
 * @param envFile non-secret runtime environment file
 */
async function createConfigured(
  context: VariantContext,
  envFile: string,
): Promise<void> {
  const { name, cli, signal, harness } = context;
  const type = harness.provider.name;
  successData(
    await cli.json(
      [
        'create',
        '--name',
        name,
        '--network',
        'tailscale',
        '--no-use-exit-node',
        '--proxy',
        '--no-github',
        '--git-name',
        GIT_NAME,
        '--git-email',
        GIT_EMAIL,
        '--no-plugins',
        '--env-file',
        envFile,
        '--provider',
        type,
      ],
      CREATE_TIMEOUT_MS,
      signal,
    ),
    'create',
  );
}

/**
 * checks configured profile, ownership, runtime env and device
 * @param context run drivers and test assertions
 */
async function checkConfigured(context: VariantContext): Promise<void> {
  const { name, cli, signal, expect, harness } = context;
  const { cleanup, provider } = harness;
  const show = successData(
    await cli.json(['show', name, '--inspect'], COMMAND_TIMEOUT_MS, signal),
    'show',
  );

  expect(show).toMatchObject({
    machine: { name, setup: 'ready' },
    inspection: {
      environment: {
        profile: {
          network: 'tailscale',
          options: { isExitNodeEnabled: false, isProxyEnabled: true },
        },
      },
      readiness: { ready: true },
    },
  });
  expect(foreignIdentifiers(await provider.inspectIdentity(name))).toEqual([]);
  // the agent's runtime environment holds exactly the file's names;
  // execute redacts, so a credential the file wrongly held shows only
  // by its variable name
  expect(
    JSON.parse(
      await asRoot(provider, name, `cat ${RUNTIME_ENV_PATH}`),
    ) as unknown,
  ).toEqual(RUNTIME_PROBE);
  await expect
    .poll(async () => (await cleanup.devicesOf(name)).length, {
      timeout: DEVICE_TIMEOUT_MS,
      interval: DEVICE_POLL_MS,
    })
    .toBe(1);
}
