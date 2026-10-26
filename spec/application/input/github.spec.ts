import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdtempDisposable,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const resolverChild = fileURLToPath(
  new URL('../../fixtures/github-resolver-child.ts', import.meta.url),
);
const emptySources = { processEnv: {}, fileEnv: {}, profile: {} };

/** builds a disposable trusted HTTPS GitHub Enterprise endpoint. */
async function githubServer() {
  const directory = await mkdtempDisposable(
    join(tmpdir(), 'open-agent-github-https-'),
  );
  const key = join(directory.path, 'key.pem');
  const certificate = join(directory.path, 'certificate.pem');
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await execute(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        key,
        '-out',
        certificate,
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { timeout: 10_000 },
    );
    const requests: Array<{
      path: string | undefined;
      authorization: string | undefined;
    }> = [];
    const acceptedToken = randomBytes(24).toString('hex');
    server = createServer(
      {
        key: await readFile(key),
        cert: await readFile(certificate),
      },
      (request, response) => {
        requests.push({
          path: request.url,
          authorization: request.headers.authorization,
        });
        const accepted =
          request.headers.authorization === `Bearer ${acceptedToken}`;
        response.writeHead(accepted ? 200 : 401, {
          'content-type': 'application/json',
        });
        response.end(
          accepted
            ? JSON.stringify({
                login: 'verified-login',
                name: 'Verified Name',
                email: 'verified@example.test',
              })
            : '{"message":"private-provider-body"}',
        );
      },
    );
    const activeServer = server;
    await new Promise<void>((resolve) =>
      activeServer.listen(0, '127.0.0.1', resolve),
    );
    const address = activeServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Local GitHub server has no TCP address');
    }

    return {
      hostname: `127.0.0.1:${address.port}`,
      acceptedToken,
      requests,
      directory,
      certificate,
      [Symbol.asyncDispose]: async () => {
        try {
          activeServer.closeAllConnections();
          await new Promise<void>((resolve) =>
            activeServer.close(() => resolve()),
          );
        } finally {
          await directory[Symbol.asyncDispose]();
        }
      },
    };
  } catch (error) {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    await directory[Symbol.asyncDispose]();
    throw error;
  }
}

/**
 * captures the actual source resolver's stdout and stderr in a bounded child.
 * @param endpoint disposable HTTPS server and certificate
 * @param cases source resolver calls to execute
 * @param environment isolated child process environment
 * @returns parsed results and both real output streams
 */
async function runResolver(
  endpoint: Awaited<ReturnType<typeof githubServer>>,
  cases: unknown[],
  environment: NodeJS.ProcessEnv = {},
) {
  const scenarioPath = join(endpoint.directory.path, 'scenario.json');
  await writeFile(scenarioPath, JSON.stringify({ cases }), { mode: 0o600 });
  const processEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ...environment,
    NODE_EXTRA_CA_CERTS: endpoint.certificate,
  };
  delete processEnvironment.NODE_TLS_REJECT_UNAUTHORIZED;
  for (const [name, value] of Object.entries(processEnvironment)) {
    if (value === undefined) {
      delete processEnvironment[name];
    }
  }
  const { stdout, stderr } = await execute(
    process.execPath,
    [resolverChild, scenarioPath],
    { cwd: process.cwd(), env: processEnvironment, timeout: 15_000 },
  );
  const results: unknown = JSON.parse(stdout);
  if (!Array.isArray(results)) {
    throw new Error('Source resolver did not return a result list');
  }

  return { results, stdout, stderr };
}

describe('fn:GitHub credential provenance', () => {
  it('should fail supplied token and explicit reference verification without leaking token or response body', async () => {
    await using endpoint = await githubServer();
    const rejectedToken = randomBytes(24).toString('hex');
    const secretPath = join(endpoint.directory.path, 'supplied-token');
    await writeFile(secretPath, `${rejectedToken}\n`, { mode: 0o600 });
    const options = {
      githubHost: endpoint.hostname,
      localCredentials: false,
      nonInteractive: true,
      gitIdentity: false,
    };
    const resolution = (sources: typeof emptySources) => ({
      required: ['githubToken'],
      sources,
    });
    const observed = await runResolver(
      endpoint,
      [
        {
          options: {
            ...options,
            githubTokenSource: 'env:OPEN_AGENT_GITHUB_SOURCE',
          },
          resolution: resolution(emptySources),
        },
        {
          options: { ...options, githubTokenSource: `file:${secretPath}` },
          resolution: resolution(emptySources),
        },
        {
          options,
          resolution: resolution({
            ...emptySources,
            processEnv: { GH_TOKEN: rejectedToken },
          }),
        },
        {
          options,
          resolution: resolution({
            ...emptySources,
            fileEnv: { GH_TOKEN: rejectedToken },
          }),
        },
        { options, stringCandidate: rejectedToken },
        {
          options,
          resolution: resolution({
            ...emptySources,
            profile: { GH_TOKEN: rejectedToken },
          }),
        },
      ],
      { OPEN_AGENT_GITHUB_SOURCE: rejectedToken, GH_TOKEN: undefined },
    );

    expect(observed.results).toHaveLength(6);
    for (const result of observed.results) {
      expect(result).toMatchObject({ ok: false, error: { code: 'AUTH' } });
    }
    expect(observed.stderr).toBe('');
    expect(observed.stdout).not.toContain(rejectedToken);
    expect(observed.stdout).not.toContain('private-provider-body');
    expect(endpoint.requests).toHaveLength(6);
    expect(
      endpoint.requests.every((request) => request.path === '/api/v3/user'),
    ).toBe(true);
    expect(
      endpoint.requests.every(
        (request) => request.authorization === `Bearer ${rejectedToken}`,
      ),
    ).toBe(true);
  });

  it('should drop only a token discovered by real gh and reuses a verified account for Git identity', async () => {
    await using endpoint = await githubServer();
    const config = join(endpoint.directory.path, 'gh-config');
    await mkdir(config, { mode: 0o700 });
    const location = {
      backend: 'protected-file',
      path: join(endpoint.directory.path, 'absent-credentials.json'),
    };
    const rejectedToken = randomBytes(24).toString('hex');
    const hostConfig = join(config, 'hosts.yml');
    const setGhToken = async (token: string) =>
      writeFile(
        hostConfig,
        `${JSON.stringify(endpoint.hostname)}:\n    oauth_token: ${token}\n    user: fixture\n    git_protocol: https\n`,
        { mode: 0o600 },
      );
    await setGhToken(rejectedToken);

    const options = { githubHost: endpoint.hostname, nonInteractive: true };
    const environment = {
      GH_CONFIG_DIR: config,
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      GIT_CONFIG_GLOBAL: join(endpoint.directory.path, 'absent-gitconfig'),
    };
    const dropped = await runResolver(
      endpoint,
      [
        {
          options,
          resolution: {
            required: ['githubToken'],
            sources: emptySources,
            credentialStore: location,
            discoverGithub: true,
          },
        },
      ],
      environment,
    );
    expect(dropped.results).toEqual([
      {
        ok: true,
        missing: [
          'GitHub token is not set. Set GH_TOKEN or pass --credential-file FILE containing GH_TOKEN; ' +
            'use --github-token-source env:NAME, file:PATH, or keychain:SERVICE/ACCOUNT; ' +
            'or run in a TTY to enter it when prompted. Or pass --no-github to skip GitHub authentication.',
        ],
      },
    ]);
    expect(dropped.stderr).toContain(
      'discovered gh credential could not be verified',
    );
    expect(dropped.stderr).not.toContain(rejectedToken);
    expect(dropped.stderr).not.toContain('private-provider-body');
    expect(dropped.stdout).not.toContain(rejectedToken);
    expect(dropped.stdout).not.toContain('private-provider-body');

    await setGhToken(endpoint.acceptedToken);
    const verified = await runResolver(
      endpoint,
      [
        {
          options,
          resolution: {
            required: ['githubToken', 'gitIdentity'],
            sources: emptySources,
            credentialStore: location,
            discoverGithub: true,
          },
        },
      ],
      environment,
    );
    expect(verified.results).toEqual([
      {
        ok: true,
        githubToken: endpoint.acceptedToken,
        gitIdentity: {
          authorName: 'Verified Name',
          authorEmail: 'verified@example.test',
          committerName: 'Verified Name',
          committerEmail: 'verified@example.test',
        },
        missing: [],
      },
    ]);
    expect(verified.stderr).toBe('');
    expect(endpoint.requests).toEqual([
      { path: '/api/v3/user', authorization: `Bearer ${rejectedToken}` },
      {
        path: '/api/v3/user',
        authorization: `Bearer ${endpoint.acceptedToken}`,
      },
    ]);
  });
});
