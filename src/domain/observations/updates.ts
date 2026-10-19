import { isRecord } from '#kernel/guards';

/** what one updater run did to one tool */
export interface UpdateToolOutcome {
  /** tool name */
  name: string;
  /** manager that upgraded it, such as `brew` */
  manager: string;
  /** whether setup refuses without it */
  required: boolean;
  /** `installed` when it is current, `skipped` when nothing ran, `failed` otherwise */
  outcome: string;
  /** version before the run, when known */
  from?: string;
  /** version after the run, when known */
  to?: string;
  /** why it failed or was skipped */
  reason?: string;
}

/** what the updater recorded about its last run in update-status.json */
export interface UpdateStatus {
  /** when the run started */
  startedAt?: string;
  /** when it finished; absent while it runs or after it was cut short */
  finishedAt?: string;
  /** when the last run every required tool succeeded in finished */
  lastSuccess?: string;
  /** what each tool's upgrade did */
  tools: UpdateToolOutcome[];
}

/**
 * reads update-status.json leniently: a field of the wrong type is dropped,
 * so an older or partial record still reports what it can
 * @param text the file's contents
 * @returns the record, or nothing when the text is not a JSON object
 */
export function parseUpdateStatus(text: string): UpdateStatus | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const tools = Array.isArray(value.tools) ? value.tools : [];

  return {
    ...stringField(value, 'startedAt'),
    ...stringField(value, 'finishedAt'),
    ...stringField(value, 'lastSuccess'),
    tools: tools.flatMap((tool: unknown) =>
      isRecord(tool) &&
      typeof tool.name === 'string' &&
      typeof tool.manager === 'string' &&
      typeof tool.outcome === 'string'
        ? [
            {
              name: tool.name,
              manager: tool.manager,
              required: tool.required === true,
              outcome: tool.outcome,
              ...stringField(tool, 'from'),
              ...stringField(tool, 'to'),
              ...stringField(tool, 'reason'),
            },
          ]
        : [],
    ),
  };
}

/**
 * keeps one string field of a record
 * @param record parsed JSON object
 * @param key name of the field kept
 * @returns the field when it is a string, otherwise nothing
 */
function stringField<Key extends string>(
  record: Record<string, unknown>,
  key: Key,
): Partial<Record<Key, string>> {
  const value = record[key];

  return typeof value === 'string'
    ? ({ [key]: value } as Partial<Record<Key, string>>)
    : {};
}
