import { describe, expect, it } from 'vitest';

import {
  hasNoClaudePendingInteractions,
  isClaudeHookNotification,
} from '#drivers/harnesses/claude/guest/claude-init-notifications';

const started = {
  type: 'system',
  subtype: 'hook_started',
  hook_id: 'hook-1',
  hook_name: 'SessionStart',
  hook_event: 'SessionStart',
  uuid: 'notification-1',
  session_id: 'session-1',
};
const responded = {
  ...started,
  subtype: 'hook_response',
  output: 'model output is not discovery evidence',
  stdout: 'permission text is not a request',
  stderr: '',
  exit_code: 0,
  outcome: 'success',
};

describe('fn:isClaudeHookNotification', () => {
  it('should recognize the observed start and response frames without using hook output as evidence', () => {
    expect(isClaudeHookNotification(started)).toBe(true);
    expect(isClaudeHookNotification(responded)).toBe(true);
  });

  it.each([
    {
      name: 'missing hook identity',
      frame: { ...started, hook_id: undefined },
    },
    { name: 'empty session identity', frame: { ...started, session_id: '' } },
    { name: 'extra start field', frame: { ...started, model: 'claude' } },
    {
      name: 'response without a numeric exit status',
      frame: { ...responded, exit_code: '0' },
    },
    {
      name: 'response without stdout',
      frame: { ...responded, stdout: undefined },
    },
    {
      name: 'response with an extra control field',
      frame: { ...responded, request_id: 'request-1' },
    },
  ])('should reject $name', ({ frame }) => {
    expect(isClaudeHookNotification(frame)).toBe(false);
  });

  it.each([
    { name: 'model output', frame: { ...started, type: 'assistant' } },
    { name: 'user input', frame: { ...started, type: 'user' } },
    {
      name: 'permission request',
      frame: { ...started, subtype: 'permission_request' },
    },
    {
      name: 'unknown system subtype',
      frame: { ...started, subtype: 'hook_progress' },
    },
    {
      name: 'control response',
      frame: { ...started, type: 'control_response' },
    },
  ])('should not treat $name as a hook notification', ({ frame }) => {
    expect(isClaudeHookNotification(frame)).toBe(false);
  });
});

describe('fn:hasNoClaudePendingInteractions', () => {
  it('should accept absent or empty known interaction queues', () => {
    expect(
      hasNoClaudePendingInteractions({ subtype: 'success', request_id: '1' }),
    ).toBe(true);
    expect(
      hasNoClaudePendingInteractions({
        subtype: 'success',
        request_id: '1',
        pending_permission_requests: [],
        pending_user_dialog_requests: [],
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: 'pending permission',
      response: { pending_permission_requests: [{ tool: 'Bash' }] },
    },
    {
      name: 'pending dialog',
      response: { pending_user_dialog_requests: [{ prompt: 'approve' }] },
    },
    {
      name: 'null permission queue',
      response: { pending_permission_requests: null },
    },
    {
      name: 'string dialog queue',
      response: { pending_user_dialog_requests: '[]' },
    },
    { name: 'other permission key', response: { permission_granted: true } },
    { name: 'other dialog key', response: { pending_dialog_requests: [] } },
  ])('should refuse $name', ({ response }) => {
    expect(hasNoClaudePendingInteractions(response)).toBe(false);
  });
});
