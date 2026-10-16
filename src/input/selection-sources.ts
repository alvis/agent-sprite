import type {
  CommandOptions,
  Interaction,
  InteractionChoice,
} from '#command/contracts';

import type { InputSources } from './sources.js';

/** what a selection is resolved from */
export interface SelectionContext {
  /** parsed flags */
  options: CommandOptions;
  /** process, dotenv and profile values */
  sources: InputSources;
  /** inline prompts; absent in non-interactive runs */
  interaction?: Interaction;
}

/** a value read or resolved from its sources, with every problem found */
export interface Resolved<T> {
  /** the value; undefined for an optional value nobody supplied */
  value: T;
  /** why supplied values could not be read */
  problems: readonly string[];
}

/** how one step reads its sources before prompting or defaulting */
interface StepSources {
  /** explicit flag value */
  flag?: string;
  /** environment variable read from the process, then the selected env file; none when only the flag applies */
  environment?: string;
}

/** precedence-aware reader of flag, process environment and env file values */
interface EnvironmentReader {
  /**
   * reads one driver id
   * @param step flag and environment variable
   * @returns the raw id, validated later against the catalog
   */
  choice(step: StepSources): string | undefined;
  /**
   * reads a comma-separated list
   * @param environment environment variable
   * @returns the trimmed entries
   */
  list(environment: string): string[] | undefined;
  /**
   * reads a boolean
   * @param flag explicit flag value
   * @param environment environment variable
   * @returns the boolean when supplied, and why a supplied value is unreadable
   */
  flag(
    flag: boolean | undefined,
    environment: string,
  ): Resolved<boolean | undefined>;
  /**
   * reads a whole number
   * @param flag explicit flag value
   * @param environment environment variable
   * @returns the number when supplied, and why a supplied value is unreadable
   */
  number(
    flag: number | undefined,
    environment: string,
  ): Resolved<number | undefined>;
}

/**
 * reads flag, process environment, then env file values in that order
 * @param sources process and env file values
 * @param scope whether environment values apply to this run
 * @param scope.isEnabled false when only flags apply
 * @returns accessors for ids, lists, booleans and whole numbers
 */
export function environmentReader(
  sources: InputSources,
  scope: { isEnabled: boolean } = { isEnabled: true },
): EnvironmentReader {
  const raw = (environment: string | undefined): string | undefined =>
    scope.isEnabled && environment !== undefined
      ? [sources.processEnv[environment], sources.fileEnv[environment]]
          .map((value) => value?.trim())
          .find((value) => Boolean(value))
      : undefined;

  return {
    choice: ({ flag, environment }) => flag ?? raw(environment),
    list: (environment) =>
      raw(environment)
        ?.split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    flag: (flag, environment) =>
      flag === undefined
        ? parseBoolean(environment, raw(environment))
        : { value: flag, problems: [] },
    number: (flag, environment) =>
      flag === undefined
        ? parseWholeNumber(environment, raw(environment))
        : { value: flag, problems: [] },
  };
}

/**
 * parses a tri-state environment boolean
 * @param name environment variable
 * @param value raw value
 * @returns the boolean, or undefined with a problem when the value is not a recognised boolean
 */
function parseBoolean(
  name: string,
  value: string | undefined,
): Resolved<boolean | undefined> {
  if (value === undefined) {
    return { value: undefined, problems: [] };
  }
  if (/^(?:1|true|yes|on)$/iu.test(value)) {
    return { value: true, problems: [] };
  }
  if (/^(?:0|false|no|off)$/iu.test(value)) {
    return { value: false, problems: [] };
  }

  return {
    value: undefined,
    problems: [`${name} must be a boolean value (true or false)`],
  };
}

/**
 * parses an environment whole number
 * @param name environment variable
 * @param value raw value
 * @returns the number, or undefined with a problem when the value is not a whole number
 */
function parseWholeNumber(
  name: string,
  value: string | undefined,
): Resolved<number | undefined> {
  if (value === undefined) {
    return { value: undefined, problems: [] };
  }

  return /^-?\d+$/u.test(value)
    ? { value: Number(value), problems: [] }
    : { value: undefined, problems: [`${name} must be a whole number`] };
}

/** what a whole-number answer must satisfy before the prompt accepts it */
interface NumberRule {
  /** what the number counts, named in the refusal of a non-number */
  unit: string;
  /** smallest accepted number */
  minimum: number;
  /**
   * refuses a number the prompt cannot take for a reason only the caller knows
   * @param value the entered number
   * @returns why the number is refused, or undefined to accept it
   */
  check?(value: number): string | undefined;
}

/** prompts that skip a step with only one choice */
export interface Prompts {
  /**
   * asks for one of several choices
   * @param message prompt label
   * @param choices catalog entries in display order, default first
   * @returns the chosen id, or undefined when only one choice exists
   */
  choose<V extends string>(
    message: string,
    choices: ReadonlyArray<InteractionChoice<V>>,
  ): Promise<V | undefined>;
  /**
   * asks for one or more of several choices
   * @param message prompt label
   * @param choices catalog entries, preselected where they are the default
   * @returns the chosen ids, or undefined when only one choice exists
   */
  chooseMany<V extends string>(
    message: string,
    choices: ReadonlyArray<InteractionChoice<V>>,
  ): Promise<V[] | undefined>;
  /**
   * asks a yes/no question
   * @param message prompt label
   * @param defaultAnswer answer Enter keeps
   * @returns the answer
   */
  confirm(message: string, defaultAnswer: boolean): Promise<boolean>;
  /**
   * asks for a whole number
   * @param message prompt label
   * @param defaultValue value Enter keeps
   * @param rule what the answer must be; whole minutes of at least 0 when absent
   * @returns the number
   */
  number(
    message: string,
    defaultValue: number,
    rule?: NumberRule,
  ): Promise<number>;
}

/** the rule of the idle-minutes prompt */
const MINUTES_RULE: NumberRule = { unit: 'minutes', minimum: 0 };

/**
 * binds the selection prompts when the run may prompt
 * @param context flags and optional interaction
 * @returns the prompts, or undefined in non-interactive runs
 */
export function activePrompts(context: SelectionContext): Prompts | undefined {
  const { interaction, options } = context;
  if (!interaction || options.nonInteractive || options.yes) {
    return undefined;
  }

  return {
    choose: async (message, choices) =>
      choices.length > 1 ? interaction.select({ message }, choices) : undefined,
    chooseMany: async (message, choices) =>
      choices.length > 1
        ? interaction.multiselect({ message }, choices)
        : undefined,
    confirm: async (message, defaultAnswer) =>
      interaction.confirm({ message, defaultAnswer }),
    number: async (message, defaultValue, rule = MINUTES_RULE) => {
      const floor =
        rule.minimum > 0 ? ` of at least ${String(rule.minimum)}` : '';

      return Number(
        await interaction.input({
          message,
          defaultValue: String(defaultValue),
          validate: (value) =>
            /^\d+$/u.test(value.trim()) && Number(value) >= rule.minimum
              ? rule.check?.(Number(value))
              : `Enter a whole number of ${rule.unit}${floor}`,
        }),
      );
    },
  };
}

/**
 * tells whether a process or env file value is nonblank
 * @param sources process and env file values
 * @param name environment variable
 * @returns true when either source has text
 */
export function hasValue(sources: InputSources, name: string): boolean {
  return [sources.processEnv[name], sources.fileEnv[name]].some((value) =>
    Boolean(value?.trim()),
  );
}
