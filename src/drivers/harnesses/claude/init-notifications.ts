import { isRecord } from '#utilities/guards';

const hookIdentityFields = [
  'hook_id',
  'hook_name',
  'hook_event',
  'uuid',
  'session_id',
];
const hookStartedFields = new Set(['type', 'subtype', ...hookIdentityFields]);
const hookResponseFields = new Set([
  ...hookStartedFields,
  'output',
  'stdout',
  'stderr',
  'exit_code',
  'outcome',
]);

/**
 * recognizes native hook notifications without treating them as discovery evidence
 * @param value untrusted native stream frame
 * @returns whether the frame is an observed, well-formed hook notification
 */
export function isClaudeHookNotification(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.type !== 'system' ||
    !hookIdentityFields.every(
      (field) => typeof value[field] === 'string' && value[field].length > 0,
    )
  ) {
    return false;
  }
  if (value.subtype === 'hook_started') {
    return Object.keys(value).every((key) => hookStartedFields.has(key));
  }

  return (
    value.subtype === 'hook_response' &&
    Object.keys(value).every((key) => hookResponseFields.has(key)) &&
    typeof value.output === 'string' &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string' &&
    typeof value.exit_code === 'number' &&
    Number.isSafeInteger(value.exit_code) &&
    typeof value.outcome === 'string' &&
    value.outcome.length > 0
  );
}

/**
 * accepts empty native interaction queues without approving any interaction
 * @param response correlated native control response envelope
 * @returns whether no pending permission or dialog traffic is present
 */
export function hasNoClaudePendingInteractions(
  response: Record<string, unknown>,
): boolean {
  return Object.entries(response).every(([key, value]) => {
    if (!/permission|dialog/u.test(key)) {
      return true;
    }

    return (
      (key === 'pending_permission_requests' ||
        key === 'pending_user_dialog_requests') &&
      Array.isArray(value) &&
      value.length === 0
    );
  });
}
