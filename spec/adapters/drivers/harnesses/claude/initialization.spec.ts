import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { inspectClaudeInitialization } from '#adapters/drivers/harnesses/claude/initialization';
import { isRecord } from '#kernel/guards';

import type {
  GuestChannel,
  GuestProcess,
} from '#application/ports/guest-channel';

/**
 * answers the actual control protocol with external initialization evidence
 * @param reply response for each requested control subtype and correlation id
 * @returns guest transport backed by in-process streams
 */
function claudeGuest(
  reply: (subtype: string, id: unknown) => unknown,
): GuestChannel {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const events = new EventEmitter();
  const process = Object.assign(events, {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: (): void => {
      events.emit('exit', 0);
    },
  }) satisfies GuestProcess;
  stdin.on('data', (chunk: Buffer) => {
    const frame: unknown = JSON.parse(chunk.toString());
    if (
      isRecord(frame) &&
      isRecord(frame.request) &&
      typeof frame.request.subtype === 'string'
    ) {
      stdout.write(
        `${JSON.stringify({ type: 'system', subtype: 'hook_started', hook_id: 'h', hook_name: 'SessionStart', hook_event: 'SessionStart', uuid: 'u', session_id: 's' })}\n`,
      );
      stdout.write(
        `${JSON.stringify(reply(frame.request.subtype, frame.request_id))}\n`,
      );
    }
  });
  stdin.on('finish', () => events.emit('exit', 0));

  return {
    spawn: () => process,
  } satisfies Partial<GuestChannel> as Partial<GuestChannel> as GuestChannel;
}

const discovery = {
  models: [{ id: 'model' }],
  commands: [{ name: 'plan' }],
  agents: [{ name: 'reviewer' }],
};

describe('fn:inspectClaudeInitialization', () => {
  it.each([
    { selected: [], loaded: [], selectedPluginsLoaded: true },
    {
      selected: ['chosen@market'],
      loaded: ['chosen@market'],
      selectedPluginsLoaded: true,
    },
    {
      selected: ['chosen@market'],
      loaded: ['other@market'],
      selectedPluginsLoaded: false,
    },
  ])(
    'should report discovery and loaded plugins for $selected',
    async ({ selected, loaded, selectedPluginsLoaded }) => {
      const guest = claudeGuest((subtype, id) => ({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: id,
          response:
            subtype === 'initialize'
              ? discovery
              : {
                  plugins: loaded.map((source) => ({ source })),
                  error_count: 0,
                },
        },
      }));

      const result = await inspectClaudeInitialization(guest, selected);

      expect(result).toEqual({
        kind: 'commands',
        modelCount: 1,
        commands: ['plan'],
        agents: ['reviewer'],
        loadedPlugins: loaded,
        selectedPluginsLoaded,
      });
    },
  );

  it.each([
    { name: 'missing models', evidence: { ...discovery, models: null } },
    {
      name: 'missing command discovery',
      evidence: { ...discovery, commands: null },
    },
    ...[null, { name: 3 }, { name: '' }].map((command) => ({
      name: `malformed command ${JSON.stringify(command)}`,
      evidence: { ...discovery, commands: [command] },
    })),
  ])('should leave evidence absent for $name', async ({ evidence }) => {
    const guest = claudeGuest((_, id) => ({
      type: 'control_response',
      response: { subtype: 'success', request_id: id, response: evidence },
    }));

    expect(await inspectClaudeInitialization(guest, [])).toBeUndefined();
  });

  it.each([
    null,
    { type: 'unexpected' },
    { type: 'control_response', response: null },
    { type: 'control_response', response: { subtype: 'error' } },
    {
      type: 'control_response',
      response: { subtype: 'success', request_id: 'wrong' },
    },
  ])('should reject an unexpected control frame %j', async (frame) => {
    const guest = claudeGuest(() => frame);

    expect(await inspectClaudeInitialization(guest, [])).toBeUndefined();
  });

  it.each([
    { name: 'missing payload', fields: {} },
    {
      name: 'pending interactions',
      fields: { response: discovery, pending_permission_requests: [{}] },
    },
  ])('should reject a correlated response with $name', async ({ fields }) => {
    const guest = claudeGuest((_, id) => ({
      type: 'control_response',
      response: { subtype: 'success', request_id: id, ...fields },
    }));

    expect(await inspectClaudeInitialization(guest, [])).toBeUndefined();
  });

  it.each([
    { name: 'missing plugins', reload: {} },
    { name: 'reload errors', reload: { plugins: [], error_count: 1 } },
    ...[null, { source: 3 }, { source: '' }].map((plugin) => ({
      name: `malformed plugin ${JSON.stringify(plugin)}`,
      reload: { plugins: [plugin] },
    })),
  ])('should leave evidence absent after $name', async ({ reload }) => {
    const guest = claudeGuest((subtype, id) => ({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: id,
        response: subtype === 'initialize' ? discovery : reload,
      },
    }));

    expect(
      await inspectClaudeInitialization(guest, ['chosen@market']),
    ).toBeUndefined();
  });
});
