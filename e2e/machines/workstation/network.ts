import { t3Service } from '#adapters/drivers/agents/t3/service';
import { tailscaleDaemon } from '#adapters/drivers/networks/tailscale/service';

import { successData } from '../cli';
import { profileTools, readEnvironment } from '../guest';

import { CREATE_TIMEOUT_MS, COMMAND_TIMEOUT_MS } from './limits';

import type { MachineHarness } from '../harness';

import type { VariantContext, WorkstationCaseContext } from './context';

const MODEL_ACCESS_FAILURE = /gateway/iu;
const NETWORK_FAILURE = /tailscale|tailnet|tailscaled|exit node|\bDNS\b/iu;

/**
 * proves the network-none workstation path
 * @param harness scoped provider, CLI and cleanup
 * @param context concurrent Vitest assertion and cancellation context
 */
export async function runNoNetworkScenario(
  harness: MachineHarness,
  context: WorkstationCaseContext,
): Promise<void> {
  const name = harness.workstationName('n');
  const cli = await harness.isolatedCli('n');
  const run = {
    harness,
    cli,
    name,
    expect: context.expect,
    signal: context.signal,
    annotate: context.annotate,
  };

  await harness.withWorkstation(name, async () => {
    await createWithoutNetwork(run);
    await checkNoNetworkServices(run);
    await checkNoNetworkCommands(run);
    await terminateWithoutNetwork(run);
  });
}

/**
 * creates and validates a workstation without a network
 * @param context run drivers and test assertions
 */
async function createWithoutNetwork(context: VariantContext): Promise<void> {
  const { name, cli, signal, expect, harness } = context;
  const { cleanup, provider } = harness;
  const type = provider.name;
  // the dotenv hub is private to the tailnet, which this workstation does
  // not join, and a harness without a gateway has no model credentials,
  // so T3 reports no ready provider and readiness withholds public
  // exposure; the workstation is retained and everything else is checked
  // on it, with the network proven to take no part in that failure
  const created = await cli.json(
    [
      'create',
      '--name',
      name,
      '--network',
      'none',
      '--no-proxy',
      '--no-git-identity',
      '--provider',
      type,
    ],
    CREATE_TIMEOUT_MS,
    signal,
  );

  expect(created.envelope.command).toBe('create');
  if (!created.envelope.ok) {
    expect(
      created.envelope.error,
      created.envelope.error?.message,
    ).toMatchObject({
      code: 'PREFLIGHT',
      outcome: 'retained',
      machine: name,
    });
  }
  expect(created.envelope.error?.message ?? '').not.toMatch(NETWORK_FAILURE);

  // neither Tailscale program is on the search path or anywhere the
  // installer or a package could have put it, under the guest root
  // included; module folders are directories, so only files and links match
  expect(
    await provider.execute(
      name,
      `command -v tailscale tailscaled; find /opt/open-agent /usr /var/lib /etc \\( -name tailscale -o -name tailscaled \\) \\( -type f -o -type l \\) 2>/dev/null; true`,
    ),
  ).toBe('');
  expect(await cleanup.devicesOf(name)).toEqual([]);
}

/**
 * checks service dependencies, local agent access and tools
 * @param context run drivers and test assertions
 */
async function checkNoNetworkServices(context: VariantContext): Promise<void> {
  const { name, expect, harness } = context;
  const { provider } = harness;
  // no tailscaled service is registered, and the agent service starts
  // after nothing
  const services = await provider.snapshotServices(name);

  expect(services.map(({ name: service }) => service)).not.toContain(
    tailscaleDaemon.name,
  );
  expect(services).toContainEqual(
    expect.objectContaining({
      name: t3Service.name,
      status: 'running',
      needs: [],
    }),
  );
  expect(
    services.filter(({ needs }) => needs.includes(tailscaleDaemon.name)),
  ).toEqual([]);

  // the agent answers on its own port without any network daemon
  expect(
    await provider.execute(
      name,
      `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${String(t3Service.httpPort)}/.well-known/t3/environment`,
    ),
  ).toBe('200');

  const installed = (await readEnvironment(provider, name)).tools.map(
    ({ name: tool }) => tool,
  );

  expect(installed).toEqual(
    expect.arrayContaining(
      profileTools({
        agent: 't3',
        harnesses: ['claude', 'codex'],
        network: 'none',
      }),
    ),
  );
  expect(installed).not.toContain('tailscale');
}

/**
 * checks show and doctor with network failures excluded
 * @param context run drivers and test assertions
 */
async function checkNoNetworkCommands(context: VariantContext): Promise<void> {
  const { name, cli, signal, expect } = context;
  const show = successData(
    await cli.json(['show', name, '--inspect'], COMMAND_TIMEOUT_MS, signal),
    'show',
  );

  expect(show).toMatchObject({
    machine: { name },
    inspection: {
      environment: { profile: { network: 'none' } },
      network: { skipped: true, online: false },
    },
  });
  expect(
    JSON.stringify([show.inspection?.network, show.inspection?.readiness]),
  ).not.toMatch(NETWORK_FAILURE);
  expect(
    show.inspection?.readiness?.failures.filter(
      (failure) => !MODEL_ACCESS_FAILURE.test(failure),
    ),
  ).toEqual([]);

  const doctor = await cli.json(['doctor', name], COMMAND_TIMEOUT_MS, signal);

  expect(doctor.envelope).toMatchObject({
    command: 'doctor',
    data: {
      machine: { name },
      currentReadiness: { network: { skipped: true, online: false } },
    },
  });
  expect(doctor.envelope).toMatchObject({
    data: {
      currentReadiness: {
        failures: expect.not.arrayContaining([
          expect.stringMatching(NETWORK_FAILURE),
        ]),
      },
    },
  });
}

/**
 * terminates the networkless workstation and proves absence
 * @param context run drivers and test assertions
 */
async function terminateWithoutNetwork(context: VariantContext): Promise<void> {
  const { name, cli, signal, expect, harness } = context;
  const { cleanup } = harness;
  const terminate = successData(
    await cli.json(['terminate', name, '--yes'], COMMAND_TIMEOUT_MS, signal),
    'terminate',
  );

  expect(terminate).toMatchObject({
    workstation: { status: 'deleted', name },
    network: { status: 'no device identity recorded' },
  });

  await cleanup.proveAbsent(name);
}
