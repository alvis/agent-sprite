import { describe, expect, it } from 'vitest';

import { createPreflightSummary } from '#create/reminders';

import type { ResolvedInputs } from '#input';

const baseInput: ResolvedInputs = {
  integrations: { tailscale: false, exitNode: false, cliproxyapi: false },
  runtimeEnv: {},
  sources: {},
  missing: [],
};

describe('fn:createPreflightSummary', () => {
  it('should provide applicable readiness checks and reminders without exposing input secrets', () => {
    const native = createPreflightSummary(baseInput);
    const enabled = createPreflightSummary(
      {
        ...baseInput,
        integrations: { tailscale: true, exitNode: true, cliproxyapi: true },
        tailscaleApiKey: 'management-secret',
        tailscaleAuthKey: 'enrollment-secret',
        githubToken: 'github-secret',
        gitIdentity: {
          authorName: 'Author',
          authorEmail: 'author@example.test',
          committerName: 'Committer',
          committerEmail: 'committer@example.test',
        },
      },
      { id: 'exit-node', name: 'exit', ip: '100.64.0.2' },
    );
    const enrollmentOnly = createPreflightSummary({
      ...baseInput,
      integrations: { tailscale: true, exitNode: false, cliproxyapi: false },
      tailscaleAuthKey: 'enrollment-secret',
    });

    expect(native).toEqual({
      checks: [
        expect.stringMatching(/Required inputs/),
        expect.stringMatching(/Sprites API/),
      ],
      reminders: [
        expect.stringMatching(/30 minutes.*seven days/),
        expect.stringMatching(/native sign-in/),
        expect.stringMatching(/Private GitHub access/),
        expect.stringMatching(/Git identity/),
      ],
    });
    expect(enabled).toEqual({
      checks: [
        expect.stringMatching(/Required inputs/),
        expect.stringMatching(/Sprites API/),
        expect.stringMatching(/Tailnet access/),
        expect.stringMatching(/exit-node identity.*approved IPv4/),
      ],
      reminders: [
        expect.stringMatching(/30 minutes.*seven days/),
        expect.stringMatching(/Guest TUN/),
        expect.stringMatching(/network policy/),
        expect.stringMatching(/enrolment key/),
        expect.stringMatching(/CLIProxyAPI authentication/),
      ],
    });
    expect(enrollmentOnly).toEqual({
      checks: [
        expect.stringMatching(/Required inputs/),
        expect.stringMatching(/Sprites API/),
      ],
      reminders: [
        expect.stringMatching(/30 minutes.*seven days/),
        expect.stringMatching(/Guest TUN/),
        expect.stringMatching(/network policy/),
        expect.stringMatching(/enrolment key/),
        expect.stringMatching(/device deletion.*authorisation/),
        expect.stringMatching(/native sign-in/),
        expect.stringMatching(/Private GitHub access/),
        expect.stringMatching(/Git identity/),
      ],
    });
    expect(JSON.stringify(enabled)).not.toMatch(
      /management-secret|enrollment-secret|github-secret/,
    );
  });
});
