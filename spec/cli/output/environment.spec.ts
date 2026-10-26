import { describe, expect, it } from 'vitest';

import { projectEnvironment } from '#cli/output/environment';

import { environmentOf } from '../../fixtures/environment';
import { TAILSCALE_PROFILE } from '../../fixtures/profile';

import type { GuestEnvironment } from '#domain/observations/environment';

describe('fn:projectEnvironment', () => {
  it('should retain a selected harness adapter, network launcher, scheduled job, and enrolled device identity', () => {
    const base = environmentOf(TAILSCALE_PROFILE);
    const launchFacts: Pick<
      GuestEnvironment,
      'agent' | 'network' | 'jobs' | 'networkIdentity'
    > = {
      agent: {
        ...base.agent,
        harnesses: [
          {
            id: 'claude',
            environment: { CLAUDE_CONFIG_DIR: '/home/agent/.claude' },
            adapter: {
              tool: 'claude-acp',
              launch: {
                program: 'claude-acp',
                arguments: ['serve'],
                account: 'agent',
                environment: { CLAUDE_CONFIG_DIR: '/home/agent/.claude' },
              },
            },
          },
          { id: 'codex', environment: { CODEX_HOME: '/home/agent/.codex' } },
        ],
      },
      network: {
        id: 'tailscale',
        daemon: 'tailscaled',
        launcher: {
          stateDirectory: '/opt/open-agent/state/tailscale',
          socket: '/var/run/tailscale/tailscaled.sock',
          tun: 'tailscale0',
        },
      },
      jobs: [
        {
          name: 'update-gate',
          everyMinutes: 60,
          run: {
            command: '/opt/open-agent/maintenance/update-gate.sh',
            arguments: [],
            account: 'root',
          },
        },
      ],
      networkIdentity: {
        network: 'tailscale',
        deviceId: 'node-123',
        ip: '192.0.2.7',
      },
    };
    const environment = environmentOf(TAILSCALE_PROFILE, launchFacts);

    expect(projectEnvironment(environment)).toEqual({
      ...base,
      ...launchFacts,
    });
  });
});
