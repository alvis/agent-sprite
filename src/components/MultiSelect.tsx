import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

import { isPrintableInput } from '#cli/keystroke';

import { choiceWindow } from './Choices.js';

import type { Dispatch, SetStateAction } from 'react';

import type { InteractionChoice } from '#command';

/** props for a searchable compatibility-aware multiple choice */
export type MultiSelectProps<V extends string> = {
  label: string;
  description?: string;
  backLabel?: string;
  choices: ReadonlyArray<InteractionChoice<V>>;
  onSubmit: (values: V[]) => void;
  onCancel: (back?: boolean) => void;
};

type InputKey = Parameters<Parameters<typeof useInput>[0]>[1];

interface MultiSelectInputContext<V extends string> {
  query: string;
  matches: ReadonlyArray<InteractionChoice<V>>;
  activeCursor: number;
  selected: ReadonlySet<V>;
  confirmEmpty: boolean;
  setQuery: Dispatch<SetStateAction<string>>;
  setCursor: Dispatch<SetStateAction<number>>;
  setSelected: Dispatch<SetStateAction<ReadonlySet<V>>>;
  setFeedback: Dispatch<SetStateAction<string>>;
  setConfirmEmpty: Dispatch<SetStateAction<boolean>>;
  onSubmit: (values: V[]) => void;
  onCancel: (back?: boolean) => void;
}

/**
 * selects multiple choices with Space toggling and Enter accepting
 * @param root0 selector props
 * @param root0.label prompt label
 * @param root0.description optional task context shown below the title
 * @param root0.backLabel optional parent destination for Escape
 * @param root0.choices available choices
 * @param root0.onSubmit selected-values callback
 * @param root0.onCancel cancellation callback
 * @returns searchable multiple choice menu
 */
export function MultiSelect<V extends string>({
  label,
  description,
  backLabel,
  choices,
  onSubmit,
  onCancel,
}: Readonly<MultiSelectProps<V>>): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<V>>(new Set());
  const [feedback, setFeedback] = useState('');
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const matches = choices.filter((choice) =>
    `${choice.label} ${choice.description ?? ''}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const { activeCursor, visible, above, below } = choiceWindow(matches, cursor);
  useInput((input, key) =>
    handleMultiSelectInput(input, key, {
      query,
      matches,
      activeCursor,
      selected,
      confirmEmpty,
      setQuery,
      setCursor,
      setSelected,
      setFeedback,
      setConfirmEmpty,
      onSubmit,
      onCancel,
    }),
  );

  if (confirmEmpty) {
    return (
      <Box flexDirection="column">
        <Text>Continue with no choices selected? [y/N]</Text>
        <Text dimColor>
          Y confirm · N/Enter/Esc return to selection · Ctrl+C cancel
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>{label}</Text>
      {description && <Text dimColor>{description}</Text>}
      <Text>Search: {query || ' '}</Text>
      {visible.map((choice) => (
        <Text dimColor={!!choice.disabledReason} key={choice.value}>
          {matches[activeCursor]?.value === choice.value ? '› ' : '  '}
          {selected.has(choice.value) ? '[x] ' : '[ ] '}
          {choice.label}
          {choice.description ? ` — ${choice.description}` : ''}
          {choice.disabledReason
            ? ` (unavailable: ${choice.disabledReason})`
            : ''}
        </Text>
      ))}
      {matches.length === 0 && <Text dimColor>No matches</Text>}
      {feedback && <Text>{feedback}</Text>}
      <Text dimColor>
        {above > 0 && `↑ ${above} more · `}
        {below > 0 && `↓ ${below} more · `}
        {selected.size} selected · ↑↓ move ·{' '}
        {query ? 'Tab toggle · Space search' : 'Space/Tab toggle'} · Enter done
        · Esc {backLabel ?? 'cancel'} · Ctrl+C cancel
      </Text>
    </Box>
  );
}

/**
 * applies one key without activating a second prompt input hook
 * @param input raw Ink input
 * @param key Ink key metadata
 * @param context current selection and state callbacks
 */
function handleMultiSelectInput<V extends string>(
  input: string,
  key: InputKey,
  context: MultiSelectInputContext<V>,
): void {
  if (key.ctrl && input === 'c') {
    return;
  }
  if (context.confirmEmpty) {
    handleEmptyConfirmation(input, key, context);

    return;
  }
  if (key.escape) {
    context.onCancel(true);

    return;
  }
  if (key.upArrow || key.downArrow) {
    const change = key.upArrow ? -1 : 1;
    context.setCursor((value) =>
      Math.max(0, Math.min(context.matches.length - 1, value + change)),
    );
    context.setFeedback('');

    return;
  }
  if (key.return) {
    if (context.selected.size === 0) {
      context.setConfirmEmpty(true);
    } else {
      context.onSubmit(Array.from(context.selected));
    }

    return;
  }
  if (key.tab || (input === ' ' && context.query.length === 0)) {
    toggleChoice(context);

    return;
  }
  handleSearchInput(input, key, context);
}

/**
 * keeps an empty selection pending until the user explicitly accepts it
 * @param input raw Ink input
 * @param key Ink key metadata
 * @param context current selection and state callbacks
 */
function handleEmptyConfirmation<V extends string>(
  input: string,
  key: InputKey,
  context: MultiSelectInputContext<V>,
): void {
  if (input.toLowerCase() === 'y') {
    context.onSubmit([]);
  } else if (key.escape || key.return || input.toLowerCase() === 'n') {
    context.setConfirmEmpty(false);
  }
}

/**
 * toggles only an available choice in the filtered viewport
 * @param context current selection and state callbacks
 */
function toggleChoice<V extends string>(
  context: MultiSelectInputContext<V>,
): void {
  const choice = context.matches[context.activeCursor];
  if (!choice) {
    context.setFeedback('No matching choices.');

    return;
  }
  if (choice.disabledReason) {
    context.setFeedback(`Unavailable: ${choice.disabledReason}`);

    return;
  }
  context.setSelected((previous) => {
    const next = new Set(previous);
    if (next.has(choice.value)) {
      next.delete(choice.value);
    } else {
      next.add(choice.value);
    }

    return next;
  });
  context.setFeedback('');
}

/**
 * edits a search query while preserving the user's selection
 * @param input raw Ink input
 * @param key Ink key metadata
 * @param context current selection and state callbacks
 */
function handleSearchInput<V extends string>(
  input: string,
  key: InputKey,
  context: MultiSelectInputContext<V>,
): void {
  if (key.backspace || input === '\u007f') {
    context.setQuery((value) => value.slice(0, -1));
  } else if (!key.ctrl && !key.meta && input && isPrintableInput(input)) {
    context.setQuery((value) => value + input);
  } else {
    return;
  }
  context.setCursor(0);
  context.setFeedback('');
}
