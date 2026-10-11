import { APIError, Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { prepareResult } from '#cli/output';
import { serializeResult } from '#cli/serialization';
import { creationOutcome } from '#create/failure';
import {
  createManagedSprite,
  MANAGED_LABEL,
  SCHEMA_LABEL,
} from '#integrations/sprites';
import { rememberSecret } from '#utilities/redaction';

describe('cmd:create failure', () => {
  it('should retain verified preflight, exact name and immutable ID after an uncertain provider create', async () => {
    const client = new SpritesClient('sdk-only-test-token');
    const sprite = Object.assign(new Sprite('new-workstation', client), {
      id: 'sprite-retained',
      labels: [MANAGED_LABEL, SCHEMA_LABEL],
    });
    vi.spyOn(client, 'createSprite').mockRejectedValue(
      new Error('provider timed out'),
    );
    vi.spyOn(client, 'getSprite').mockResolvedValue(sprite);
    const preflight = {
      checks: ['provider name was available'],
      reminders: ['complete setup before use'],
    };

    const result = await createManagedSprite(client, sprite.name).then(
      () => {
        throw new Error('Expected provider creation to fail');
      },
      (error: unknown) => creationOutcome(error, preflight),
    );

    expect(result).toMatchObject({
      command: 'create',
      ok: false,
      error: {
        code: 'PROVIDER',
        machine: sprite.name,
        machineId: sprite.id,
        outcome: 'retained',
        setupIncomplete: true,
      },
      data: { preflight },
    });
    expect(serializeResult(result)).toMatchObject({
      schemaVersion: 1,
      data: { preflight },
      error: { machine: sprite.name, machineId: sprite.id },
    });
  });

  it('should report an unknown provider outcome without inventing an ID', async () => {
    const client = new SpritesClient('sdk-only-test-token');
    vi.spyOn(client, 'createSprite').mockRejectedValue(
      new Error('provider timed out'),
    );
    vi.spyOn(client, 'getSprite').mockRejectedValue(
      new Error('reconciliation unavailable'),
    );

    const result = await createManagedSprite(client, 'new-workstation').then(
      () => {
        throw new Error('Expected provider creation to fail');
      },
      (error: unknown) =>
        creationOutcome(error, { checks: ['name was checked'], reminders: [] }),
    );

    expect(result).toMatchObject({
      command: 'create',
      ok: false,
      error: {
        code: 'PROVIDER',
        machine: 'new-workstation',
        outcome: 'unknown',
      },
      data: { preflight: { checks: ['name was checked'] } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected a create failure');
    }
    expect(result.error.machineId).toBeUndefined();
  });

  it('should report definite absence only after a rejected create and exact SDK APIError 404 lookup', async () => {
    const client = new SpritesClient('sdk-only-test-token');
    const secret = 'create-provider-sensitive-token';
    rememberSecret(secret);
    const cause = new Error(`provider rejected ${secret} ${'x'.repeat(700)}`);
    const create = vi.spyOn(client, 'createSprite').mockRejectedValue(cause);
    const lookup = vi
      .spyOn(client, 'getSprite')
      .mockRejectedValue(new APIError('missing', { statusCode: 404 }));
    const preflight = { checks: ['name was checked'], reminders: [] };
    const result = await createManagedSprite(client, 'absent-machine').then(
      () => {
        throw new Error('Expected provider creation to fail');
      },
      (error: unknown) => creationOutcome(error, preflight),
    );

    expect(create).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      command: 'create',
      ok: false,
      error: { code: 'PROVIDER', machine: 'absent-machine', outcome: 'absent' },
      data: { preflight },
    });
    if (result.ok) {
      throw new Error('Expected a failed result');
    }
    expect(result.error.machineId).toBeUndefined();
    expect(result.error.details?.[0]?.length).toBeLessThanOrEqual(
      512 + 'Creation cause: '.length,
    );
    const human = prepareResult(result, {});
    const json = prepareResult(result, { json: true });
    expect(human.channel).toBe('stderr');
    expect(human.text).toContain(
      'Provider lookup confirmed this Sprite is absent',
    );
    expect(json.channel).toBe('stdout');
    expect(JSON.parse(json.text)).toMatchObject({
      error: { outcome: 'absent' },
    });
    expect(json.text.trim().split('\n')).toHaveLength(1);
    for (const output of [human.text, json.text]) {
      expect(output).toContain('Creation cause: provider rejected [REDACTED]');
      expect(output).not.toContain(secret);
      expect(output).not.toContain('x'.repeat(600));
    }
  });
});
