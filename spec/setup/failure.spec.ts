import { Sprite, SpritesClient } from '@fly/sprites';
import { describe, expect, it, vi } from 'vitest';

import { prepareResult } from '#cli/output';
import {
  MANAGED_LABEL,
  SETUP_INCOMPLETE_LABEL,
  VERSION_LABEL_PREFIX,
} from '#drivers/providers/sprite/labels';
import { CommandFault } from '#errors';
import { resolveSecret } from '#input/sources';
import { InteractionExit } from '#navigation';
import { setupFailure } from '#setup/failure';

import { providerOf } from '../mocks/sprites';

import type { WorkstationRecord } from '#drivers/contracts';

/**
 * binds a provider to one Sprite and returns its verified record
 * @param sprite Sprite the provider lookup returns
 * @returns the bound provider and the workstation record it returned
 */
async function bindWorkstation(sprite: Sprite): Promise<{
  provider: ReturnType<typeof providerOf>;
  workstation: WorkstationRecord;
}> {
  vi.spyOn(sprite.client, 'getSprite').mockResolvedValue(sprite);
  const provider = providerOf(sprite.client);

  return { provider, workstation: await provider.get(sprite.name) };
}

describe('fn:setupFailure', () => {
  it('should report stopped setup as incomplete after changes and preserve unrelated labels', async () => {
    const sprite = Object.assign(
      new Sprite('primary', new SpritesClient('test-token')),
      {
        id: 'sprite-primary',
        organizationName: 'test-organization',
        labels: [MANAGED_LABEL, 'unrelated'],
      },
    );
    const update = vi.fn<Sprite['update']>(async (options) =>
      Object.assign(sprite, options),
    );
    Object.assign(sprite, { update });

    const result = await setupFailure({
      ...(await bindWorkstation(sprite)),
      error: new InteractionExit('back'),
      mutation: { started: true },
    });

    expect(result).toMatchObject({
      ok: false,
      data: { recovery: { incompleteLabel: 'confirmed' } },
      error: {
        code: 'CANCELLED',
        machine: 'primary',
        machineId: 'sprite-primary',
        setupIncomplete: true,
      },
    });
    // the stopped run also records the release that last touched the guest
    expect(sprite.labels).toEqual([
      MANAGED_LABEL,
      'unrelated',
      SETUP_INCOMPLETE_LABEL,
      expect.stringMatching(new RegExp(`^${VERSION_LABEL_PREFIX}`, 'u')),
    ]);
    expect(update).toHaveBeenCalledOnce();
    expect(prepareResult(result, {}).text).toContain(
      'Incomplete label: confirmed',
    );
  });

  it('should report an unconfirmed label and merges original and recovery details without changing the primary code', async () => {
    const sprite = Object.assign(
      new Sprite('primary', new SpritesClient('test-token')),
      {
        id: 'sprite-primary',
        organizationName: 'test-organization',
        labels: [MANAGED_LABEL],
      },
    );
    const labelFailure = new Error('label write refused');
    vi.spyOn(sprite, 'update').mockRejectedValue(labelFailure);
    const prior = new Error('prior setup cause');
    const primary = new CommandFault({
      code: 'PREFLIGHT',
      message: 'setup failed',
      cause: prior,
    });

    const result = await setupFailure({
      ...(await bindWorkstation(sprite)),
      error: primary,
      mutation: { started: true },
      section: 'agent',
    });

    expect(result).toMatchObject({
      command: 'setup',
      ok: false,
      data: { recovery: { incompleteLabel: 'unconfirmed' } },
      error: {
        code: 'PREFLIGHT',
        message: 'setup failed',
        machine: 'primary',
        machineId: 'sprite-primary',
        setupIncomplete: true,
        details: [
          expect.stringContaining('label write refused'),
          expect.stringContaining('prior setup cause'),
          expect.stringContaining('incomplete label could not be confirmed'),
          'Failed setup section: agent',
          'Retry: open-agent setup "primary" --section agent',
        ],
      },
    });
    expect(primary.cause).toBeInstanceOf(AggregateError);
    expect((primary.cause as AggregateError).errors).toEqual([
      prior,
      labelFailure,
    ]);
    const human = prepareResult(result, {});
    const json = prepareResult(result, { json: true });
    expect(human.channel).toBe('stderr');
    expect(human.text).toContain('Incomplete label: unconfirmed');
    expect(human.text).toContain('label write refused');
    expect(json.channel).toBe('stdout');
    expect(json.text.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(json.text)).toMatchObject({
      error: { code: 'PREFLIGHT', machineId: 'sprite-primary' },
      data: { recovery: { incompleteLabel: 'unconfirmed' } },
    });
  });

  it('should redact actual setup failures without marking untouched guests incomplete', async () => {
    const secret = await resolveSecret(undefined, 'saf08-setup-resolved-key');
    const result = await setupFailure({
      provider: providerOf(new SpritesClient('test-token')),
      workstation: {
        id: 'sprite-primary',
        name: 'primary',
        organization: 'test-organization',
        state: 'running',
        metadata: { setup: 'not recorded' },
      },
      error: new Error(`rejected ${secret}`),
      mutation: { started: false },
      section: 'github',
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'UNEXPECTED',
        details: [
          'Failed setup section: github',
          'Retry: open-agent setup "primary" --section github',
        ],
      },
    });
    expect(result.error?.message).toContain('[REDACTED]');
    expect(result.error?.message).not.toContain(secret);
    expect(result.error?.setupIncomplete).toBeUndefined();
  });
});
