import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { prepareResult, writePreparedResult, writeResult } from '#cli/output';
import { serializeResult } from '#cli/serialization';
import { commandError } from '#errors';
import { resolveSecret } from '#input/sources';
import { PairingSecret } from '#utilities/pairing-secret';
import { rememberSecret } from '#utilities/redaction';

import type { CommandOptions, CommandResult } from '#command';
import type { CurrentReadiness } from '#command/data';
import type { GuestInspection } from '#integrations/guest/runtime';
import type { MachineSummary } from '#machine';

const machine: MachineSummary = {
  id: 'sprite-primary',
  name: 'primary',
  organization: 'example',
  state: 'running',
  setup: 'ready',
  readiness: 'not inspected',
};

const inspection: GuestInspection = {
  services: [],
  tailscale: {
    online: false,
    dnsReady: false,
    skipped: true,
    reason: 'Tailscale is disabled',
  },
  native: {
    claude: {
      gatewayConfigured: false,
      modelDiscoveryEnabled: false,
      pluginListAvailable: false,
      authentication: 'not-configured',
    },
    codex: {
      gatewayConfigured: false,
      modelDiscoveryEnabled: false,
      pluginListAvailable: false,
      authentication: 'not-configured',
    },
    t3ClaudePluginLoading: 'not-verified',
    t3CodexPluginLoading: 'not-verified',
    claudeSdkPluginLoading: 'not-verified',
    selectedClaudePlugins: [],
    selectedCodexPlugins: [],
  },
  hub: {
    skipped: true,
    reachable: false,
    reason: 'CLIProxyAPI is disabled',
  },
  manifest: {
    schema: 1,
    createdAt: '2026-10-09T00:00:00.000Z',
    installedVersions: {},
  },
  integrations: { tailscale: false, exitNode: false, cliproxyapi: false },
  probeFailures: [],
};

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
        machines: [
          {
            ...machine,
            name: 'alpha',
            id: 'sprite-alpha',
            createdAt: '2026-10-09T12:00:00.000Z',
            t3Url: 'https://alpha.sprites.app/',
            organization: 'org-one',
          },
          {
            ...machine,
            name: 'beta',
            id: 'sprite-beta',
            state: 'cold',
            createdAt: undefined,
            t3Url: undefined,
            setup: 'not recorded',
            organization: 'org-two',
          },
        ],
      },
    };
    const prepared = prepareResult(result, {}, streams);
    const expected =
      'alpha\tsprite-alpha\trunning\t2026-10-09T12:00:00.000Z\thttps://alpha.sprites.app/\tready\torg-one\n' +
      'beta\tsprite-beta\tcold\t\t\tnot recorded\torg-two\n';

    expect(prepared).toEqual({ channel: 'stdout', text: expected });
    writePreparedResult(prepared, streams);
    expect({ stdout: out, stderr: err }).toEqual({
      stdout: expected,
      stderr: '',
    });
    stdout.destroy();
    stderr.destroy();
  });

  it('should emit no TSV row for an empty list', () => {
    const output = captureResult(
      { command: 'list', ok: true, data: { machines: [] } },
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
          machines: [
            {
              ...machine,
              name: 'tab\tline\nslash\\tail',
              id: 'sprite-\u001b[31m',
              state: 'run\rring',
              createdAt: undefined,
              t3Url: `https://primary.sprites.app/#token=${secret}`,
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
    ]);
    expect(output.stdout).not.toContain(secret);
    expect(output.stdout).not.toContain('\u001b');
    expect(output.stdout).not.toContain('\u009b');
  });

  it('should keep JSON ahead of pipe TSV and human failures on stderr', () => {
    const json = captureResult(
      { command: 'list', ok: true, data: { machines: [machine] } },
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
          tailscale: inspection.tailscale,
          hub: inspection.hub,
          native: inspection.native,
          services: [{ name: 't3-code', state: 'running' }],
          manifest: inspection.manifest,
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

    expect(output.stdout).toContain('Tailscale is disabled');
    expect(output.stdout).toContain('CLIProxyAPI is disabled');
    expect(output.stdout).toContain('Reachable: No');
    expect(output.stderr).toBe('');
  });

  it('should render failed readiness facts without executable service internals', () => {
    const currentReadiness: CurrentReadiness = {
      ready: false,
      failures: ['t3-provider-discovery'],
      skipped: [],
      probeFailures: [],
      services: [{ name: 't3-code', state: 'running' }],
      tailscale: { ...inspection.tailscale, exitNodeName: 'home-router' },
      hub: inspection.hub,
      native: inspection.native,
      manifest: inspection.manifest,
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
    expect(output.stderr).toContain('t3-provider-discovery');
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
            t3Url: 'https://retained.sprites.app/',
          },
          sprite: {
            status: 'deleted',
            id: 'sprite-retained',
            name: 'retained-machine',
          },
          tailnet: { status: 'cleanup required', deviceId: 'managed-node' },
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
    expect(output.stderr).toContain('T3 URL: https://retained.sprites.app/');
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
          t3Url: pairing.forUrl('https://primary.sprites.app/'),
        },
        inspection: {
          ...inspection,
          manifest: {
            ...inspection.manifest,
            lastUpdateError: 'hidden-proxy-key',
          },
        },
        pairing: { status: 'created', token: pairing },
      },
    };

    const marked = captureResult(result, { json: true });
    const disclosed = captureResult(result, {
      json: true,
      withT3PairCode: true,
    });
    const disclosedHuman = captureResult(result, { withT3PairCode: true });

    expect(marked.stderr).toBe('');
    expect(marked.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(marked.stdout)).toMatchObject({
      schemaVersion: 1,
      data: {
        machine: {
          t3Url: 'https://primary.sprites.app/#token=requested-pairing-token',
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
        t3Url: 'https://primary.sprites.app/#token=requested-pairing-token',
      },
      pairing: { token: 'requested-pairing-token' },
      inspection: { manifest: { lastUpdateError: '[REDACTED]' } },
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
          tailscale: {
            ...inspection.tailscale,
            reason: `Tailscale rejected ${secret} twice: ${secret}`,
          },
          manifest: {
            ...inspection.manifest,
            lastUpdateError: `updater rejected ${secret} twice: ${secret}`,
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
            tailscale: inspection.tailscale,
            hub: inspection.hub,
            native: inspection.native,
            services: [],
            manifest: inspection.manifest,
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
