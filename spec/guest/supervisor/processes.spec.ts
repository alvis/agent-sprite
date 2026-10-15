import { describe, expect, it, vi } from 'vitest';

import { commandLine } from '#guest/supervisor/processes';

import type { SupervisedService } from '#guest/supervisor/protocol';

const PREFIX = ['/usr/bin/switch', '--to-agent', '--'] as const;
const ENVIRONMENT = { PATH: '/usr/bin' };

/**
 * builds the two accounts with a trust check that records what it is asked
 * @returns the accounts, the trust check and the paths it was asked about
 */
function fixture(): {
  accounts: Parameters<typeof commandLine>[0]['accounts'];
  trust: (path: string) => Promise<string>;
  trusted: string[];
} {
  const trusted: string[] = [];

  return {
    accounts: {
      root: { prefix: [], cwd: '/', environment: ENVIRONMENT },
      agent: { prefix: PREFIX, cwd: '/home/agent', environment: ENVIRONMENT },
    },
    trust: vi.fn(async (path: string) => {
      trusted.push(path);

      return path;
    }),
    trusted,
  };
}

/**
 * defines a service
 * @param account who runs it
 * @param args its arguments
 * @returns the definition
 */
function service(
  account: SupervisedService['account'],
  args: string[],
): SupervisedService {
  return {
    name: 'probe',
    command: '/opt/open-agent/bin/probe',
    arguments: args,
    account,
    needs: [],
  };
}

describe('fn:commandLine', () => {
  it('should check the command and every whole absolute path a root service is given', async () => {
    const { accounts, trust, trusted } = fixture();

    const line = await commandLine(
      { accounts, trust },
      service('root', ['-f', '/opt/open-agent/launcher.js', '--verbose']),
    );

    expect({ line, trusted }).toEqual({
      line: [
        '/opt/open-agent/bin/probe',
        '-f',
        '/opt/open-agent/launcher.js',
        '--verbose',
      ],
      trusted: ['/opt/open-agent/bin/probe', '/opt/open-agent/launcher.js'],
    });
  });

  it.each([
    ['an option holding a path', '--config=/tmp/evil.json'],
    ['a relative path', './evil.js'],
    ['a parent path', '../evil.js'],
    ['a nested relative path', 'dir/evil.js'],
    ['a path after a separator', '-c/tmp/evil'],
  ])(
    'should refuse a root service whose argument is %s, naming its position and not its text',
    async (_label, argument) => {
      const { accounts, trust, trusted } = fixture();

      const message = await commandLine(
        { accounts, trust },
        service('root', ['-f', argument]),
      ).then(
        () => 'accepted',
        (error: unknown) => (error as Error).message,
      );

      expect({
        message,
        isTextLeaked: message.includes(argument),
        trusted,
      }).toEqual({
        message: expect.stringContaining(
          'probe runs as root, and its argument 2 embeds a path that cannot be checked',
        ),
        isTextLeaked: false,
        trusted: [],
      });
    },
  );

  it('should pass an agent service its path-bearing arguments and check only the account switch', async () => {
    const { accounts, trust, trusted } = fixture();

    const line = await commandLine(
      { accounts, trust },
      service('agent', ['--config=/home/agent/x.json', './relative']),
    );

    expect({ line, trusted }).toEqual({
      line: [
        ...PREFIX,
        '/opt/open-agent/bin/probe',
        '--config=/home/agent/x.json',
        './relative',
      ],
      trusted: ['/usr/bin/switch'],
    });
  });
});
