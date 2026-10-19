import { describe, expect, it } from 'vitest';

import {
  readSetupSelection,
  resolveCreateSelection,
  resolveSetupSelection,
  selectionRequirements,
} from '#application/input/selection';
import { suppliedSelectionViolations } from '#application/input/selection-supplied';
import { defaults } from '#composition/defaults';
import { defaultProfile } from '#domain/profile';
import { MAX_UPDATE_DUE_DAYS } from '#domain/profile-rules';

import { dependencies } from '../../mocks/dependencies';

import type { SetupSection } from '#application/contracts';
import type { SelectionContext } from '#application/input/selection-sources';
import type { InputSources } from '#application/input/sources';
import type {
  Interaction,
  InteractionChoice,
  InteractionPrompt,
} from '#application/ports/interaction';
import type { WorkstationProfile } from '#domain/profile';

const empty: InputSources = { processEnv: {}, fileEnv: {}, profile: {} };

/**
 * reads a setup run's supplied values, then merges them with the recorded profile
 * @param context flags, sources, prompts, recorded profile and targeted section
 * @returns the resolved setup selection
 */
async function resolveSetup(
  context: SelectionContext & {
    recorded: WorkstationProfile;
    section: SetupSection;
  },
): ReturnType<typeof resolveSetupSelection> {
  const { value: supplied } = readSetupSelection(dependencies, context);

  return resolveSetupSelection(dependencies, { ...context, supplied });
}

/**
 * records the prompts a selection run asks, answering each with its default
 * @returns the interaction and the asked prompt messages
 */
function recordingInteraction(): {
  interaction: Interaction;
  asked: string[];
} {
  const asked: string[] = [];
  const interaction: Interaction = {
    async input({ message, defaultValue }) {
      asked.push(message);

      return defaultValue ?? '';
    },
    async secret({ message }) {
      asked.push(message);

      return '';
    },
    async select<V extends string>(
      { message }: InteractionPrompt,
      choices: ReadonlyArray<InteractionChoice<V>>,
    ): Promise<V> {
      asked.push(message);
      const [first] = choices;
      if (!first) {
        throw new Error(`no choice offered for ${message}`);
      }

      return first.value;
    },
    async multiselect<V extends string>(
      { message }: InteractionPrompt,
      choices: ReadonlyArray<InteractionChoice<V>>,
    ): Promise<V[]> {
      asked.push(message);

      return choices
        .filter(({ isPreselected }) => isPreselected === true)
        .map(({ value }) => value);
    },
    async confirm({ message, defaultAnswer }) {
      asked.push(message);

      return defaultAnswer ?? false;
    },
    progress: () => undefined,
    status: () => undefined,
  };

  return { interaction, asked };
}

describe('fn:resolveCreateSelection', () => {
  it('should ask provider, harnesses, network and the supported options in order while skipping single-choice steps and hold-max', async () => {
    const { interaction, asked } = recordingInteraction();

    const { candidate } = await resolveCreateSelection(dependencies, {
      options: {},
      sources: empty,
      interaction,
    });

    expect(asked).toEqual([
      'Provider',
      'Minimum CPUs',
      'Minimum memory (GB)',
      'Release channel',
      'Harnesses',
      'Network',
      'Route harnesses through CLIProxyAPI?',
      'Suspend after idle (minutes, 0 = never)',
    ]);
    expect(candidate).toMatchObject({
      provider: 'sprite',
      agent: 't3',
      harnesses: ['claude', 'codex'],
      network: 'none',
    });
  });

  it('should ask for an exit node only when the selected network supports one', async () => {
    const { interaction, asked } = recordingInteraction();

    await resolveCreateSelection(dependencies, {
      options: { network: 'tailscale' },
      sources: empty,
      interaction,
    });

    expect(asked).toContain('Use an exit node?');
  });

  it('should not prompt for a step a flag already answers', async () => {
    const { interaction, asked } = recordingInteraction();

    const { candidate } = await resolveCreateSelection(dependencies, {
      options: {
        provider: 'sprite',
        cpu: 4,
        mem: 8,
        release: 'stable',
        harness: ['codex'],
        network: 'tailscale',
        useExitNode: false,
        proxy: false,
        idleMinutes: 0,
      },
      sources: empty,
      interaction,
    });

    expect(asked).toEqual([]);
    expect(candidate.options.idleTimeoutMinutes).toBe(0);
  });

  it('should take the flag over the env file over the process environment', async () => {
    const sources: InputSources = {
      processEnv: { OPEN_AGENT_IDLE_MINUTES: '15' },
      fileEnv: { OPEN_AGENT_IDLE_MINUTES: '45', OPEN_AGENT_NETWORK: 'none' },
      profile: {},
    };

    const fromEnvironment = await resolveCreateSelection(dependencies, {
      options: { nonInteractive: true },
      sources,
    });
    const fromFlag = await resolveCreateSelection(dependencies, {
      options: { nonInteractive: true, idleMinutes: 0 },
      sources,
    });

    expect(fromEnvironment.candidate.options.idleTimeoutMinutes).toBe(45);
    expect(fromEnvironment.candidate.network).toBe('none');
    expect(fromFlag.candidate.options.idleTimeoutMinutes).toBe(0);
  });

  it('should report an unreadable whole number instead of guessing', async () => {
    const { problems } = await resolveCreateSelection(dependencies, {
      options: { nonInteractive: true },
      sources: {
        processEnv: { OPEN_AGENT_IDLE_MINUTES: 'soon' },
        fileEnv: {},
        profile: {},
      },
    });

    expect(problems).toEqual([
      'OPEN_AGENT_IDLE_MINUTES must be a whole number',
    ]);
  });

  it('should take the update due interval from the flag, then the env file, then the process environment, then the default, without prompting', async () => {
    const { interaction, asked } = recordingInteraction();
    const sources: InputSources = {
      processEnv: { OPEN_AGENT_UPDATE_DUE_DAYS: '3' },
      fileEnv: { OPEN_AGENT_UPDATE_DUE_DAYS: '9' },
      profile: {},
    };

    const fromSources = await resolveCreateSelection(dependencies, {
      options: { network: 'tailscale' },
      sources,
      interaction,
    });
    const fromFlags = await resolveCreateSelection(dependencies, {
      options: { nonInteractive: true, updateDueDays: 2 },
      sources,
    });
    const fromDefaults = await resolveCreateSelection(dependencies, {
      options: { nonInteractive: true },
      sources: empty,
    });

    expect(asked.filter((message) => /update/iu.test(message))).toEqual([]);
    expect(
      [fromSources, fromFlags, fromDefaults].map(
        ({ candidate: { options } }) => options.updateDueIntervalDays,
      ),
    ).toEqual([9, 2, 1]);
  });

  it('should report an unreadable update interval instead of guessing', async () => {
    const { problems } = await resolveCreateSelection(dependencies, {
      options: { nonInteractive: true },
      sources: {
        processEnv: { OPEN_AGENT_UPDATE_DUE_DAYS: '1.5' },
        fileEnv: {},
        profile: {},
      },
    });

    expect(problems).toEqual([
      'OPEN_AGENT_UPDATE_DUE_DAYS must be a whole number',
    ]);
  });

  it('should report every unreadable boolean and number together without prompting', async () => {
    const { interaction, asked } = recordingInteraction();

    const { problems } = await resolveCreateSelection(dependencies, {
      options: {},
      sources: {
        processEnv: {
          OPEN_AGENT_USE_EXIT_NODE: 'maybe',
          CLIPROXYAPI_ENABLED: 'sometimes',
          OPEN_AGENT_HOLD_MAX_MINUTES: 'soon',
        },
        fileEnv: {},
        profile: {},
      },
      interaction,
    });

    expect(asked).toEqual([]);
    expect(problems).toEqual([
      'OPEN_AGENT_USE_EXIT_NODE must be a boolean value (true or false)',
      'CLIPROXYAPI_ENABLED must be a boolean value (true or false)',
      'OPEN_AGENT_HOLD_MAX_MINUTES must be a whole number',
    ]);
  });

  it('should default an option prompt to the value its inputs imply', async () => {
    const { interaction } = recordingInteraction();

    const { candidate } = await resolveCreateSelection(dependencies, {
      options: { network: 'tailscale' },
      sources: {
        processEnv: { TAILSCALE_EXIT_NODE: 'exit-node' },
        fileEnv: {},
        profile: {},
      },
      interaction,
    });

    expect(candidate.options.isExitNodeEnabled).toBe(true);
  });
});

describe('fn:resolveSetupSelection', () => {
  it('should keep the recorded selection and take provider and agent only from flags', async () => {
    const recorded = defaultProfile(defaults, 'none');

    const { candidate } = await resolveSetup({
      options: { agent: 't3' },
      sources: {
        processEnv: { OPEN_AGENT_NETWORK: 'tailscale' },
        fileEnv: {},
        profile: {},
      },
      recorded,
      section: 'git',
    });

    expect(candidate).toMatchObject({
      provider: 'sprite',
      agent: 't3',
      harnesses: recorded.harnesses,
      network: 'none',
    });
  });

  it('should select an installable network when the network section targets a workstation without one', async () => {
    const { candidate } = await resolveSetup({
      options: { nonInteractive: true },
      sources: empty,
      recorded: defaultProfile(defaults, 'none'),
      section: 'network',
    });

    expect(candidate.network).toBe('tailscale');
  });

  it('should keep the recorded exit node when only the proxy section is targeted', async () => {
    const tailscale = defaultProfile(defaults, 'tailscale');
    const recorded = {
      ...tailscale,
      options: { ...tailscale.options, isExitNodeEnabled: true },
    };

    const { candidate } = await resolveSetup({
      options: { nonInteractive: true, useExitNode: false, proxy: false },
      sources: {
        processEnv: { OPEN_AGENT_IDLE_MINUTES: '5' },
        fileEnv: {},
        profile: {},
      },
      recorded,
      section: 'proxy',
    });

    expect(candidate.network).toBe('tailscale');
    expect(candidate.options).toEqual({
      ...recorded.options,
      isProxyEnabled: false,
    });
  });

  it('should keep the recorded proxy when only the network section is targeted', async () => {
    const tailscale = defaultProfile(defaults, 'tailscale');
    const recorded = {
      ...tailscale,
      options: { ...tailscale.options, isProxyEnabled: true },
    };

    const { candidate } = await resolveSetup({
      options: { nonInteractive: true, proxy: false, useExitNode: true },
      sources: empty,
      recorded,
      section: 'network',
    });

    expect(candidate.options).toEqual({
      ...recorded.options,
      isExitNodeEnabled: true,
    });
  });

  it('should not read an environment value the targeted section does not own', () => {
    const { value, problems } = readSetupSelection(dependencies, {
      options: {},
      sources: {
        processEnv: {
          OPEN_AGENT_USE_EXIT_NODE: 'maybe',
          CLIPROXYAPI_ENABLED: 'true',
        },
        fileEnv: {},
        profile: {},
      },
      section: 'proxy',
    });

    expect(problems).toEqual([]);
    expect(value.options).toEqual({
      isExitNodeEnabled: undefined,
      isProxyEnabled: true,
      idleTimeoutMinutes: undefined,
      holdMaxMinutes: undefined,
    });
  });
});

describe('fn:resolveSetupSelection update intervals', () => {
  it('should apply a supplied update interval to the recorded profile when the tools section is targeted', async () => {
    const recorded = defaultProfile(defaults, 'none');

    const { candidate } = await resolveSetup({
      options: { nonInteractive: true, updateDueDays: 3 },
      sources: empty,
      recorded,
      section: 'tools',
    });

    expect(candidate.options).toEqual({
      ...recorded.options,
      updateDueIntervalDays: 3,
    });
  });

  it('should not read an update interval the targeted section does not own', () => {
    const { value, problems } = readSetupSelection(dependencies, {
      options: {},
      sources: {
        processEnv: { OPEN_AGENT_UPDATE_DUE_DAYS: 'often' },
        fileEnv: {},
        profile: {},
      },
      section: 'proxy',
    });

    expect({ problems, options: value.options }).toEqual({
      problems: [],
      options: {
        isExitNodeEnabled: undefined,
        isProxyEnabled: undefined,
        idleTimeoutMinutes: undefined,
        holdMaxMinutes: undefined,
        updateDueIntervalDays: undefined,
      },
    });
  });
});

describe('fn:suppliedSelectionViolations', () => {
  it('should report supplied option bounds and capabilities whose drivers are all known', () => {
    const violations = suppliedSelectionViolations(
      dependencies,
      {
        network: 'none',
        options: { isExitNodeEnabled: true, holdMaxMinutes: 0 },
      },
      { isPairingRequested: false },
    );

    expect(violations.map(({ message }) => message)).toEqual([
      '--use-exit-node (OPEN_AGENT_USE_EXIT_NODE) needs a network that supports exit nodes; "none" does not',
      '--hold-max-minutes (OPEN_AGENT_HOLD_MAX_MINUTES) must be a whole number of minutes of at least 1',
    ]);
  });

  it('should report an update interval below one together with the other violations', () => {
    const violations = suppliedSelectionViolations(
      dependencies,
      {
        network: 'none',
        options: { holdMaxMinutes: 0, updateDueIntervalDays: -2 },
      },
      { isPairingRequested: false },
    );

    expect(violations.map(({ message }) => message)).toEqual([
      expect.stringContaining('--hold-max-minutes'),
      expect.stringContaining('--update-due-days'),
    ]);
  });

  it('should state the allowed range when an update interval is beyond its upper bound', () => {
    const violations = suppliedSelectionViolations(
      dependencies,
      {
        network: 'none',
        options: { updateDueIntervalDays: MAX_UPDATE_DUE_DAYS + 1 },
      },
      { isPairingRequested: false },
    );

    expect(violations.map(({ message }) => message)).toEqual([
      `--update-due-days (OPEN_AGENT_UPDATE_DUE_DAYS) must be a whole number of days from 1 to ${String(MAX_UPDATE_DUE_DAYS)}`,
    ]);
  });

  it('should leave a capability that depends on the recorded profile for later', () => {
    const violations = suppliedSelectionViolations(
      dependencies,
      { options: { isExitNodeEnabled: true } },
      { isPairingRequested: false },
    );

    expect(violations).toEqual([]);
  });

  it('should report an unknown supplied driver id', () => {
    const violations = suppliedSelectionViolations(
      dependencies,
      { agent: 'nope', options: {} },
      { isPairingRequested: false },
    );

    expect(violations.map(({ message }) => message)).toEqual([
      expect.stringContaining('Unknown ACP agent "nope"'),
    ]);
  });
});

describe('fn:selectionRequirements', () => {
  it('should require network inputs only for an installable network and skip enrollment for an enrolled device', () => {
    const none = defaultProfile(defaults, 'none');
    const tailscale = defaultProfile(defaults, 'tailscale');
    const routed = {
      ...tailscale,
      options: { ...tailscale.options, isExitNodeEnabled: true },
    };

    expect(
      selectionRequirements(dependencies, {
        profile: none,
        base: ['providerToken'],
      }),
    ).toEqual(['providerToken']);
    expect(selectionRequirements(dependencies, { profile: routed })).toEqual([
      'networkEnrollment',
      'networkAccount',
      'exitNode',
    ]);
    expect(
      selectionRequirements(dependencies, {
        profile: tailscale,
        base: [],
        isEnrolled: true,
      }),
    ).toEqual(['networkAccount']);
  });
});
