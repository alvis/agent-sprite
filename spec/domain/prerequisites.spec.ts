import { describe, expect, it } from 'vitest';

import {
  checkDeclaredPrerequisites,
  missingInput,
  refusedCredential,
} from '#domain/prerequisites';

import type {
  CredentialPrerequisite,
  ProviderPrerequisites,
  ProviderPreflightParams,
} from '#domain/prerequisites';

const credential: CredentialPrerequisite = {
  label: 'Example API token',
  environment: 'EXAMPLE_TOKEN',
  store: 'example',
  scope: 'an Example organization token',
  obtain: 'Get one at https://example.test/account.',
  refused: [{ pattern: /^FlyV1\s/u, holds: 'a Fly API token' }],
};

const prerequisites: ProviderPrerequisites = {
  tools: [
    {
      command: 'exampletool',
      minimumVersion: '1.9.0',
      fix: 'Upgrade exampletool.',
    },
  ],
  credential,
  documentation: [],
};

/**
 * builds host probes that report a tool and the version it prints
 * @param probe what the host reports
 * @param probe.path where the tool is found, or undefined when absent
 * @param probe.version text the version command prints, or undefined when it fails
 * @param probe.token resolved credential
 * @returns preflight parameters
 */
function host(probe: {
  path?: string;
  version?: string;
  token?: string;
}): ProviderPreflightParams {
  return {
    credential: probe.token,
    credentialSource: 'EXAMPLE_TOKEN in the process environment',
    findTool: async () => probe.path,
    readVersion: async () => probe.version,
  };
}

describe('fn:checkDeclaredPrerequisites', () => {
  it('should report a tool that is not on PATH', async () => {
    const problems = await checkDeclaredPrerequisites(
      prerequisites,
      host({ token: 'example' }),
    );

    expect(problems).toEqual([
      {
        subject: 'exampletool',
        problem: 'exampletool is not on PATH',
        fix: 'Upgrade exampletool.',
      },
    ]);
  });

  it('should report a tool older than the minimum by numeric comparison', async () => {
    const problems = await checkDeclaredPrerequisites(
      prerequisites,
      host({
        path: '/bin/exampletool',
        version: 'exampletool v1.8.12\n',
        token: 'example',
      }),
    );

    expect(problems.map(({ problem }) => problem)).toEqual([
      'exampletool 1.8.12 is older than 1.9.0',
    ]);
  });

  it('should accept a newer version that sorts lower as text', async () => {
    const problems = await checkDeclaredPrerequisites(
      prerequisites,
      host({
        path: '/bin/exampletool',
        version: 'exampletool 1.10.0.',
        token: 'example',
      }),
    );

    expect(problems).toEqual([]);
  });

  it('should report a tool that prints no version', async () => {
    const problems = await checkDeclaredPrerequisites(
      prerequisites,
      host({ path: '/bin/exampletool', token: 'example' }),
    );

    expect(problems.map(({ problem }) => problem)).toEqual([
      'exampletool did not report a version; 1.9.0 or later is required',
    ]);
  });

  it('should report a missing credential with every source it is read from', async () => {
    const problems = await checkDeclaredPrerequisites(
      { ...prerequisites, tools: [] },
      host({}),
    );

    expect(problems).toEqual([
      {
        subject: 'EXAMPLE_TOKEN',
        problem: 'Example API token is not set',
        fix: expect.stringContaining('--provider-token-source'),
      },
    ]);
  });

  it('should name the source of a refused credential', async () => {
    const problems = await checkDeclaredPrerequisites(
      { ...prerequisites, tools: [] },
      host({ token: 'FlyV1 fm2_abc' }),
    );

    expect(problems).toEqual([
      {
        subject: 'EXAMPLE_TOKEN',
        problem:
          'EXAMPLE_TOKEN in the process environment holds a Fly API token; the provider needs an Example organization token',
        fix: 'Replace it with an Example organization token. Get one at https://example.test/account.',
      },
    ]);
  });
});

describe('fn:refusedCredential', () => {
  it('should leave any other shape for the provider to accept or reject', () => {
    expect(
      refusedCredential(credential, { token: 'org/abc/def' }),
    ).toBeUndefined();
  });

  it('should describe an entered value without a source', () => {
    expect(
      refusedCredential(credential, { token: ' FlyV1 fm2_abc ' })?.problem,
    ).toBe(
      'The entered value holds a Fly API token; the provider needs an Example organization token',
    );
  });
});

describe('fn:missingInput', () => {
  it('should name the variable, the env file, the flag and the prompt, then any guidance', () => {
    const problem = missingInput(
      {
        environment: 'EXAMPLE_ACCOUNT',
        prompt: 'Example account',
        flag: '--example-account ACCOUNT',
      },
      'Or pass --no-example to skip it.',
    );

    expect(problem).toEqual({
      subject: 'EXAMPLE_ACCOUNT',
      problem: 'Example account is not set',
      fix:
        'Set EXAMPLE_ACCOUNT or pass --credential-file FILE containing EXAMPLE_ACCOUNT; ' +
        'use --example-account ACCOUNT; or run in a TTY to enter it when prompted. ' +
        'Or pass --no-example to skip it.',
    });
  });
});
