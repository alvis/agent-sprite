import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { prepareResult, writePreparedResult, writeResult } from '#cli/output';
import { serializeResult } from '#cli/serialization';
import { commandError } from '#errors';
import { resolveSecret } from '#input/sources';
import { PairingSecret } from '#utilities/pairing-secret';
import { rememberSecret } from '#utilities/redaction';

import { environmentOf } from '../fixtures/environment';
import { DISABLED_NETWORK_PROFILE } from '../fixtures/profile';

import type { CommandResult } from '#command';
import type { CommandOptions } from '#command/contracts';
import type { CurrentReadiness } from '#command/data';
import type { GovernorState } from '#integrations/guest/governor-report';
import type { GuestInspection } from '#integrations/guest/inspection-types';
import type { UpdateToolOutcome } from '#integrations/guest/updates';
import type { MachineSummary } from '#machine';

const machine: MachineSummary & { provider: 'sprite' } = {
  provider: 'sprite',
  id: 'sprite-primary',
  name: 'primary',
  organization: 'example',
  state: 'running',
  setup: 'ready',
  readiness: 'not inspected',
};

const RECORDED_GOVERNOR: GovernorState = {
  version: 1,
  updatedAt: '2026-10-09T00:10:00.000Z',
  keepAwakeMode: 'native-deadline',
  idleTimeoutMinutes: 5,
  holdMaxMinutes: 60,
  lastHeartbeat: '2026-10-09T00:10:00.000Z',
  holds: [],
  openHolds: 0,
  deadline: '2026-10-09T00:15:00.000Z',
  sleepPermitted: false,
  diagnostics: [],
};
const inspection: GuestInspection = {
  services: [],
  network: {
    online: false,
    dnsReady: false,
    skipped: true,
    reason: 'No private network is selected',
  },
  native: {
    claude: {
      gatewayConfigured: false,
      modelDiscoveryEnabled: false,
      pluginListAvailable: false,
      awakeHooksInstalled: false,
      authentication: 'not-configured',
    },
    codex: {
      gatewayConfigured: false,
      modelDiscoveryEnabled: false,
      pluginListAvailable: false,
      awakeHooksInstalled: false,
      authentication: 'not-configured',
    },
    harnesses: {
      claude: {
        selectedPlugins: [],
        evidence: { sdkPluginLoading: 'not-verified' },
      },
      codex: {
        selectedPlugins: [],
        evidence: undefined,
      },
    },
  },
  hub: {
    skipped: true,
    reachable: false,
    reason: 'CLIProxyAPI is disabled',
  },
  environment: environmentOf(DISABLED_NETWORK_PROFILE),
  probeFailures: [],
  governor: { recorded: true, state: RECORDED_GOVERNOR },
};

/**
 * an optional tool the last update failed to upgrade
 * @param name tool name
 * @param reason why the upgrade failed
 * @returns the recorded outcome
 */
function failedUpdate(name: string, reason: string): UpdateToolOutcome {
  return { name, manager: 'brew', required: false, outcome: 'failed', reason };
}

/**
 * Captures writes to the real output stream seam.
 * @param result completed command result
 * @param options output controls
 * @returns text written to each channel
 */
function captureResult(
  result: CommandResult,
  options: CommandOptions,
): { stdout: string; stderr: string } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  try {
    writeResult(result, options, { stdout, stderr });
  } finally {
    stdout.destroy();
    stderr.destroy();
  }

  return { stdout: out, stderr: err };
}

describe('fn:writeResult', () => {
  it('should prepare and writes headerless pipe TSV in workstation column order with blank optional fields', () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const streams = { stdout, stderr };
    let out = '';
    let err = '';
    stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    const result: CommandResult = {
      command: 'list',
      ok: true,
      data: {
        unavailable: [],
        machines: [
          {
            ...machine,
            name: 'alpha',
            id: 'sprite-alpha',
            createdAt: '2026-10-09T12:00:00.000Z',
            agentUrl: 'https://alpha.sprites.app/',
            organization: 'org-one',
          },
          {
            ...machine,
            name: 'beta',
            id: 'sprite-beta',
            state: 'cold',
            createdAt: undefined,
            agentUrl: undefined,
            setup: 'not recorded',
            organization: 'org-two',
          },
        ],
      },
    };
    const prepared = prepareResult(result, {}, streams);
    const expected =
      'alpha\tsprite-alpha\trunning\t2026-10-09T12:00:00.000Z\thttps://alpha.sprites.app/\tready\torg-one\tsprite\n' +
      'beta\tsprite-beta\tcold\t\t\tnot recorded\torg-two\tsprite\n';

    expect(prepared).toEqual({ channel: 'stdout', text: expected });
    writePreparedResult(prepared, streams);
    expect({ stdout: out, stderr: err }).toEqual({
      stdout: expected,
      stderr: '',
    });
    stdout.destroy();
    stderr.destroy();
  });

  it('should name each unavailable provider on stderr beside piped TSV rows', () => {
    const reason =
      'workstation status unknown, no Fly organization token was found; supply one in FLY_API_TOKEN, or with --provider fly-machine --provider-token-source, to list its workstations';
    const output = captureResult(
      {
        command: 'list',
        ok: true,
        data: {
          machines: [{ ...machine, name: 'alpha', id: 'sprite-alpha' }],
          unavailable: [{ provider: 'fly-machine', code: 'INPUT', reason }],
        },
      },
      {},
    );

    expect(output).toEqual({
      stdout: 'alpha\tsprite-alpha\trunning\t\t\tready\texample\tsprite\n',
      stderr: `Unavailable provider fly-machine: ${reason}\n`,
    });
  });

  it('should emit no TSV row for an empty list', () => {
    const output = captureResult(
      { command: 'list', ok: true, data: { machines: [], unavailable: [] } },
      {},
    );

    expect(output).toEqual({ stdout: '', stderr: '' });
  });

  it('should escape delimiters and terminal controls after redacting pipe TSV fields', () => {
    const secret = 'generated-list-secret';
    rememberSecret(secret);
    const output = captureResult(
      {
        command: 'list',
        ok: true,
        data: {
          unavailable: [],
          machines: [
            {
              ...machine,
              name: 'tab\tline\nslash\\tail',
              id: 'sprite-\u001b[31m',
              state: 'run\rring',
              createdAt: undefined,
              agentUrl: `https://primary.sprites.app/#token=${secret}`,
              organization: 'org\u009b[0m',
            },
          ],
        },
      },
      {},
    );
    const rows = output.stdout.split('\n');
    const columns = rows[0]!.split('\t');

    expect(output.stderr).toBe('');
    expect(rows).toHaveLength(2);
    expect(columns).toEqual([
      'tab\\tline\\nslash\\\\tail',
      'sprite-\\u001b[31m',
      'run\\rring',
      '',
      'https://primary.sprites.app/#token=[REDACTED]',
      'ready',
      'org\\u009b[0m',
      'sprite',
    ]);
    expect(output.stdout).not.toContain(secret);
    expect(output.stdout).not.toContain('\u001b');
    expect(output.stdout).not.toContain('\u009b');
  });

  it('should keep JSON ahead of pipe TSV and human failures on stderr', () => {
    const json = captureResult(
      {
        command: 'list',
        ok: true,
        data: { machines: [machine], unavailable: [] },
      },
      { json: true },
    );
    const failure = captureResult(
      {
        command: 'list',
        ok: false,
        error: { code: 'PROVIDER', message: 'List unavailable' },
      },
      {},
    );

    expect(json.stderr).toBe('');
    expect(json.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'list',
      ok: true,
      data: { machines: [{ name: 'primary', id: 'sprite-primary' }] },
    });
    expect(failure).toEqual({ stdout: '', stderr: 'List unavailable\n' });
  });

  it('should keep a successful shared local-credential change machine-free in human and JSON output', () => {
    const result: CommandResult = {
      command: 'setup',
      ok: true,
      data: {
        localCredential: {
          status: 'replaced',
          scope: 'this computer; all workstations',
          storage: 'protected-file',
        },
      },
    };
    const human = captureResult(result, {});
    const json = captureResult(result, { json: true });
    const serialized = serializeResult(result);

    expect(Object.keys(serialized.data ?? {})).toEqual(['localCredential']);
    expect(human.stderr).toBe('');
    expect(human.stdout).toContain('replaced');
    expect(human.stdout).toContain('protected-file');
    expect(json.stderr).toBe('');
    expect(json.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'setup',
      ok: true,
      data: {
        localCredential: {
          status: 'replaced',
          scope: 'this computer; all workstations',
          storage: 'protected-file',
        },
      },
    });
    expect(Object.keys(JSON.parse(json.stdout).data)).toEqual([
      'localCredential',
    ]);
  });

  it('should render successful current readiness on stdout with a versioned JSON alternative', () => {
    const result: CommandResult = {
      command: 'doctor',
      ok: true,
      data: {
        machine,
        currentReadiness: {
          ready: true,
          failures: [],
          skipped: ['Tailscale connectivity'],
          probeFailures: [],
          network: inspection.network,
          hub: inspection.hub,
          native: inspection.native,
          services: [{ name: 't3-code', state: 'running' }],
          environment: inspection.environment,
          governor: inspection.governor,
        },
      },
    };
    const human = captureResult(result, {});
    const json = captureResult(result, { json: true });

    expect(human.stdout).toContain('Ready: Yes');
    expect(human.stdout).toContain('Tailscale connectivity');
    expect(human.stderr).toBe('');
    expect(json.stderr).toBe('');
    expect(JSON.parse(json.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'doctor',
      ok: true,
      data: { currentReadiness: { ready: true, failures: [] } },
    });
  });

  it('should show disabled checks from a typed inspection on stdout', () => {
    const output = captureResult(
      { command: 'show', ok: true, data: { machine, inspection } },
      {},
    );

    expect(output.stdout).toContain('No private network is selected');
    expect(output.stdout).toContain('CLIProxyAPI is disabled');
    expect(output.stdout).toContain('Reachable: No');
    expect(output.stderr).toBe('');
  });

  it('should show whether each harness has the awake hooks installed', () => {
    const output = captureResult(
      {
        command: 'show',
        ok: true,
        data: {
          machine,
          inspection: {
            ...inspection,
            native: {
              ...inspection.native!,
              claude: {
                ...inspection.native!.claude!,
                awakeHooksInstalled: true,
              },
              codex: {
                ...inspection.native!.codex!,
                awakeHooksInstalled: false,
              },
            },
          },
        },
      },
      {},
    );

    expect(output.stdout.replaceAll(/\s+/g, ' ')).toMatch(
      /Awake hooks installed: Yes.*Awake hooks installed: No/,
    );
  });

  it('should name the tools the last update failed in the maintenance details', () => {
    const output = captureResult(
      {
        command: 'show',
        ok: true,
        data: {
          machine,
          inspection: {
            ...inspection,
            updates: {
              startedAt: '2026-10-09T00:00:00.000Z',
              finishedAt: '2026-10-09T00:01:00.000Z',
              tools: [
                failedUpdate('ripgrep-failure-fixture', 'no bottle'),
                {
                  name: 'gh',
                  manager: 'brew',
                  required: false,
                  outcome: 'installed',
                },
              ],
            },
          },
        },
      },
      {},
    );

    expect(output.stdout).toContain('ripgrep-failure-fixture');
  });

  describe('idle governor line by keep-awake mode', () => {
    const NOW = Date.parse('2026-10-09T00:12:00.000Z');
    /**
     * shows a machine whose governor state differs from the fixture's
     * @param state fields replacing the fixture's recorded state
     * @returns the flattened human output
     */
    const governorOutput = (state: Partial<GovernorState>): string => {
      const output = captureResult(
        {
          command: 'show',
          ok: true,
          data: {
            machine,
            inspection: {
              ...inspection,
              governor: {
                recorded: true,
                state: {
                  ...RECORDED_GOVERNOR,
                  ...state,
                },
              },
            },
          },
        },
        {},
      );

      return output.stdout.replaceAll(/\s+/g, ' ');
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should show a native-deadline provider as awake until the deadline and then on its own idle rules, never as sleep not permitted', () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });

      const output = governorOutput({});

      expect(output).toMatch(
        /Idle governor.*last heartbeat 2026-10-09T00:10:00\.000Z; 0 open holds; awake until 2026-10-09T00:15:00\.000Z, then the provider's idle rules apply/,
      );
      expect(output).not.toContain('sleep not permitted');
      expect(output).not.toContain('sleep permitted');
    });

    it('should mark a passed deadline as passed', () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW + 10 * 60_000 });

      expect(governorOutput({})).toMatch(
        /awake deadline 2026-10-09T00:15:00\.000Z passed, the provider's idle rules apply/,
      );
    });

    it('should show a native-deadline provider with nothing keeping it awake and a released task', () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      expect(
        governorOutput({
          deadline: undefined,
          adapter: {
            at: '2026-10-09T00:10:00.000Z',
            action: 'apply-deadline',
            result: 'released',
          },
        }),
      ).toMatch(
        /0 open holds; nothing keeps it awake, the provider's idle rules apply; awake task released/,
      );
    });

    it('should keep the sleep wording for a governed provider and mark its passed deadline', () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      const governed = governorOutput({ keepAwakeMode: 'governed' });
      vi.setSystemTime(NOW + 10 * 60_000);
      const passed = governorOutput({
        keepAwakeMode: 'governed',
        sleepPermitted: true,
      });

      expect(governed).toMatch(
        /awake until 2026-10-09T00:15:00\.000Z; sleep not permitted/,
      );
      expect(passed).toMatch(
        /awake until 2026-10-09T00:15:00\.000Z \(passed\); sleep permitted/,
      );
    });

    it('should show a provider that never keeps the workstation awake as not governed', () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });

      const output = governorOutput({
        keepAwakeMode: 'none',
        deadline: undefined,
      });

      expect(output).toMatch(/0 open holds; not governed/);
      expect(output).not.toContain('sleep');
    });
  });

  it('should show why no idle governor state is recorded and the last adapter failure', () => {
    const unrecorded = captureResult(
      {
        command: 'show',
        ok: true,
        data: {
          machine,
          inspection: {
            ...inspection,
            governor: {
              recorded: false,
              reason: 'no awake event has been recorded yet',
            },
          },
        },
      },
      {},
    );
    const failing = captureResult(
      {
        command: 'show',
        ok: true,
        data: {
          machine,
          inspection: {
            ...inspection,
            governor: {
              recorded: true,
              state: {
                version: 1,
                updatedAt: '2026-10-09T00:10:00.000Z',
                idleTimeoutMinutes: 5,
                holdMaxMinutes: 60,
                holds: [],
                openHolds: 1,
                sleepPermitted: true,
                adapter: {
                  at: '2026-10-09T00:10:00.000Z',
                  action: 'enter-idle-form',
                  failure: 'suspend refused',
                },
                diagnostics: [],
              },
            },
          },
        },
      },
      {},
    );

    expect(unrecorded.stdout.replaceAll(/\s+/g, ' ')).toMatch(
      /Idle governor.*not recorded \(no awake event has been recorded yet\)/,
    );
    expect(failing.stdout.replaceAll(/\s+/g, ' ')).toMatch(
      /Idle governor.*no heartbeat yet; 1 open hold; nothing keeps it awake; sleep permitted; adapter failed: suspend refused/,
    );
  });

  it('should show guest-supplied governor text without control characters', () => {
    const output = captureResult(
      {
        command: 'show',
        ok: true,
        data: {
          machine,
          inspection: {
            ...inspection,
            governor: {
              recorded: true,
              state: {
                version: 1,
                updatedAt: '2026-10-09T00:10:00.000Z',
                idleTimeoutMinutes: 5,
                holdMaxMinutes: 60,
                holds: [],
                openHolds: 0,
                sleepPermitted: false,
                adapter: {
                  at: '2026-10-09T00:10:00.000Z',
                  action: 'enter-idle-form',
                  failure: 'suspend\u001b[2J refused\u009b31m',
                },
                diagnostics: [],
              },
            },
          },
        },
      },
      {},
    );

    expect(output.stdout).not.toMatch(/\p{Cc}(?<!\n)/u);
    expect(output.stdout.replaceAll(/\s+/g, ' ')).toContain(
      'adapter failed: suspend[2J refused31m',
    );
  });

  it('should render failed readiness facts without executable service internals', () => {
    const currentReadiness: CurrentReadiness = {
      ready: false,
      failures: ['T3 environment endpoint'],
      skipped: [],
      probeFailures: [],
      services: [{ name: 't3-code', state: 'running' }],
      network: { ...inspection.network, exitNodeName: 'home-router' },
      hub: inspection.hub,
      native: inspection.native,
      environment: inspection.environment,
      governor: inspection.governor,
    };
    const output = captureResult(
      {
        command: 'doctor',
        ok: false,
        error: { code: 'PREFLIGHT', message: 'Readiness check failed' },
        data: { machine: { ...machine, state: 'cold' }, currentReadiness },
      },
      {},
    );

    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('Readiness check failed');
    expect(output.stderr).toContain('T3 environment endpoint');
    expect(output.stderr).toContain('home-router');
  });

  it('should keep retained identity and partial cleanup facts on stderr', () => {
    const output = captureResult(
      {
        command: 'terminate',
        ok: false,
        error: {
          code: 'PROVIDER',
          message: 'Tailnet cleanup required',
          machine: 'retained-machine',
          machineId: 'sprite-retained',
          setupIncomplete: true,
          details: ['Retry setup after checking the managed device'],
        },
        data: {
          machine: {
            ...machine,
            name: 'retained-machine',
            agentUrl: 'https://retained.sprites.app/',
          },
          workstation: {
            status: 'deleted',
            id: 'sprite-retained',
            name: 'retained-machine',
          },
          network: { status: 'cleanup required', deviceId: 'managed-node' },
        },
      },
      {},
    );

    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('Tailnet cleanup required');
    expect(output.stderr).toContain('Workstation: retained-machine');
    expect(output.stderr).toContain('Workstation ID: sprite-retained');
    expect(output.stderr).toContain('Setup is incomplete');
    expect(output.stderr).toContain(
      'Retry setup after checking the managed device',
    );
    expect(output.stderr).toContain('managed-node');
    expect(output.stderr).toContain('Agent URL: https://retained.sprites.app/');
  });

  it('should write a human cancellation only to stderr', () => {
    const output = captureResult(
      {
        command: 'terminate',
        ok: false,
        error: { code: 'CANCELLED', message: 'Typed name did not match' },
      },
      {},
    );

    expect(output).toEqual({
      stdout: '',
      stderr: 'Typed name did not match\n',
    });
  });

  it('should disclose a marked pairing code and URL together but keeps other credentials redacted', () => {
    const pairing = new PairingSecret({ token: 'requested-pairing-token' });
    rememberSecret('hidden-proxy-key');
    const result: CommandResult = {
      command: 'show',
      ok: true,
      data: {
        machine: {
          ...machine,
          agentUrl: pairing.forUrl('https://primary.sprites.app/'),
        },
        inspection: {
          ...inspection,
          updates: { tools: [failedUpdate('gh', 'hidden-proxy-key')] },
        },
        pairing: { status: 'created', token: pairing },
      },
    };

    const marked = captureResult(result, { json: true });
    const disclosed = captureResult(result, {
      json: true,
      withPairCode: true,
    });
    const disclosedHuman = captureResult(result, { withPairCode: true });

    expect(marked.stderr).toBe('');
    expect(marked.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(marked.stdout)).toMatchObject({
      schemaVersion: 1,
      data: {
        machine: {
          agentUrl:
            'https://primary.sprites.app/#token=requested-pairing-token',
        },
        pairing: { token: 'requested-pairing-token' },
      },
    });
    expect(marked.stdout).not.toContain('hidden-proxy-key');
    expect(JSON.stringify(result)).not.toContain('requested-pairing-token');
    expect(disclosed.stderr).toBe('');
    expect(disclosed.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(disclosed.stdout).data).toMatchObject({
      machine: {
        agentUrl: 'https://primary.sprites.app/#token=requested-pairing-token',
      },
      pairing: { token: 'requested-pairing-token' },
      inspection: { updates: { tools: [{ reason: '[REDACTED]' }] } },
    });
    expect(disclosed.stdout).not.toContain('hidden-proxy-key');
    expect(disclosedHuman.stdout).toContain(
      'https://primary.sprites.app/#token=requested-pairing-token',
    );
    expect(disclosedHuman.stdout).toContain('requested-pairing-token');
    expect(disclosedHuman.stdout).not.toContain('hidden-proxy-key');
  });

  it('should redact a resolved value in nested results and non-Error failures in both output modes', async () => {
    const secret = await resolveSecret(undefined, 'saf08-nested-output-secret');
    const success: CommandResult = {
      command: 'show',
      ok: true,
      data: {
        machine,
        inspection: {
          ...inspection,
          network: {
            ...inspection.network,
            reason: `Tailscale rejected ${secret} twice: ${secret}`,
          },
          updates: {
            tools: [
              failedUpdate('gh', `updater rejected ${secret} twice: ${secret}`),
            ],
          },
        },
      },
    };
    const failure: CommandResult = {
      command: 'show',
      ok: false,
      error: {
        ...commandError(`provider rejected ${secret}`),
        details: [`retry without ${secret}`],
      },
    };

    for (const options of [{}, { json: true }]) {
      const nested = captureResult(success, options);
      const rejected = captureResult(failure, options);
      const successText = `${nested.stdout}${nested.stderr}`;
      const failureText = `${rejected.stdout}${rejected.stderr}`;

      expect(successText).toContain('[REDACTED]');
      expect(successText).not.toContain(secret);
      expect(failureText).toContain('[REDACTED]');
      expect(failureText).not.toContain(secret);
      expect(options.json ? rejected.stdout : rejected.stderr).toContain(
        'retry without [REDACTED]',
      );
    }
  });

  it('should write one versioned JSON failure with typed readiness to stdout', () => {
    const output = captureResult(
      {
        command: 'doctor',
        ok: false,
        error: {
          code: 'PREFLIGHT',
          message: 'Readiness check failed',
          machine: 'primary',
          details: ['Inspect the T3 service'],
        },
        data: {
          machine,
          currentReadiness: {
            ready: false,
            failures: ['t3-service'],
            skipped: [],
            probeFailures: [],
            network: inspection.network,
            hub: inspection.hub,
            native: inspection.native,
            services: [],
            environment: inspection.environment,
            governor: inspection.governor,
          },
        },
      },
      { json: true },
    );

    expect(output.stderr).toBe('');
    expect(output.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'doctor',
      ok: false,
      error: { code: 'PREFLIGHT', machine: 'primary' },
      data: { currentReadiness: { ready: false, failures: ['t3-service'] } },
    });
  });
});
