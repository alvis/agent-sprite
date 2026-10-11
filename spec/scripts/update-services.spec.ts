import { describe, expect, it } from 'vitest';

import {
  assertServiceAction as untypedAssertServiceAction,
  parseManagedService as untypedParseManagedService,
  registeredManagedServices as untypedRegisteredManagedServices,
} from '#scripts/update-services';

const registeredManagedServices = untypedRegisteredManagedServices as (
  output: string,
  selected: string[],
) => string[];
const parseManagedService = untypedParseManagedService as (
  output: string,
  name: string,
) => { name: string; state?: { status: string; pid?: number } };
const assertServiceAction = untypedAssertServiceAction;

const t3 = {
  name: 't3-code',
  cmd: '/opt/agent-sprite/t3',
  args: ['serve'],
  needs: [],
  state: { name: 't3-code', status: 'running', pid: 101 },
};
const tailnet = {
  name: 'tailscaled',
  cmd: '/opt/agent-sprite/tailscaled',
  args: [],
  needs: [],
  state: { name: 'tailscaled', status: 'running', pid: 102 },
};

describe('managed updater service responses', () => {
  it.each([
    { registry: [], expected: [] },
    { registry: [t3], expected: ['t3-code'] },
    { registry: [tailnet], expected: ['tailscaled'] },
    { registry: [t3, tailnet], expected: ['t3-code', 'tailscaled'] },
  ])(
    'should select only names present in a validated complete registry',
    ({ registry, expected }) => {
      const output = JSON.stringify(registry);

      expect(
        registeredManagedServices(output, ['t3-code', 'tailscaled']),
      ).toEqual(expected);
      expect(registeredManagedServices(output, ['t3-code'])).toEqual(
        expected.filter((name) => name === 't3-code'),
      );
    },
  );

  it.each([
    '',
    'permission denied',
    '{}',
    '{"services":[]}',
    '[{}]',
    JSON.stringify([{ ...t3, args: undefined }]),
    JSON.stringify([t3, t3]),
    JSON.stringify([{ ...t3, state: { name: 'wrong', status: 'running' } }]),
    JSON.stringify([
      { ...t3, state: { name: 't3-code', status: 'running', pid: -1 } },
    ]),
  ])(
    'should reject an unverified registry instead of treating it as absence',
    (output) => {
      expect(() => registeredManagedServices(output, ['t3-code'])).toThrow(
        expect.objectContaining({ code: 'PROVIDER' }),
      );
    },
  );

  it('should accept documented get records with omitted optional fields', () => {
    expect(
      parseManagedService(
        JSON.stringify({ name: 't3-code', cmd: '/opt/agent-sprite/t3' }),
        't3-code',
      ),
    ).toMatchObject({ name: 't3-code' });
  });

  it('should normalize a live get record with null needs after a list record with empty needs', () => {
    const selected = registeredManagedServices(
      JSON.stringify([{ ...tailnet, needs: [] }]),
      ['tailscaled'],
    );
    const fetched = parseManagedService(
      JSON.stringify({ ...tailnet, needs: null }),
      'tailscaled',
    );

    expect(selected).toEqual(['tailscaled']);
    expect(fetched).toEqual(tailnet);
  });

  it.each([false, 'tailscaled', {}, [''], [42]])(
    'should reject a malformed non-null get dependency value',
    (needs) => {
      expect(() =>
        parseManagedService(
          JSON.stringify({ ...tailnet, needs }),
          'tailscaled',
        ),
      ).toThrow(
        expect.objectContaining({
          code: 'PROVIDER',
        }),
      );
    },
  );

  it.each([
    JSON.stringify({
      ...t3,
      name: 'other',
      state: { name: 'other', status: 'running' },
    }),
    JSON.stringify({ ...t3, state: { name: 't3-code', status: 'unknown' } }),
    JSON.stringify({ error: 'permission denied' }),
    'not json',
  ])('should reject malformed or mismatched get records', (output) => {
    expect(() => parseManagedService(output, 't3-code')).toThrow(
      expect.objectContaining({ code: 'PROVIDER' }),
    );
  });

  it('should accept successful action events', () => {
    expect(() => assertServiceAction('{"type":"complete"}\n')).not.toThrow();
    expect(() =>
      assertServiceAction('{"type":"exit","exit_code":0}\n'),
    ).not.toThrow();
  });

  it.each([
    ['no events', ''],
    ['malformed provider output', 'permission denied private-action-output'],
    ['error event', '{"type":"error"}\n'],
    ['exit without status', '{"type":"exit"}\n'],
    ['nonzero exit', '{"type":"exit","exit_code":1}\n'],
    ['unknown event', '{"type":"unknown"}\n'],
  ])('should reject %s as a provider failure', (_reason, output) => {
    expect(() => assertServiceAction(output)).toThrow(
      expect.objectContaining({
        code: 'PROVIDER',
        ...(output.includes('private-action-output')
          ? {
              cause: expect.any(SyntaxError),
              message: expect.not.stringContaining('private-action-output'),
            }
          : {}),
      }),
    );
  });

  it('should retain a private parse cause without copying raw registry or get output into the diagnostic', () => {
    for (const parse of [
      () => registeredManagedServices('private-registry-output', ['t3-code']),
      () => parseManagedService('private-get-output', 't3-code'),
    ]) {
      expect(parse).toThrow(
        expect.objectContaining({
          code: 'PROVIDER',
          cause: expect.any(SyntaxError),
          message: expect.not.stringContaining('private-'),
        }),
      );
    }
  });
});
