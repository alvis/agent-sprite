import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

import { isPrintableInput } from '#cli/keystroke';

import type { InteractionChoice } from '#application/ports/interaction';

/** props for a searchable single choice */
type SelectProps<V extends string> = {
  label: string;
  description?: string;
  backLabel?: string;
  choices: ReadonlyArray<InteractionChoice<V>>;
  onSubmit: (value: V) => void;
  onCancel: (back?: boolean) => void;
};

interface ChoiceWindow<V extends string> {
  activeCursor: number;
  visible: ReadonlyArray<InteractionChoice<V>>;
  above: number;
  below: number;
}

const VISIBLE_CHOICES = 8;
const CURSOR_CONTEXT = 5;

/**
 * shows a searchable inline menu with reasons beside unavailable choices
 * @param root0 selector props
 * @param root0.label prompt label
 * @param root0.description optional task context shown below the title
 * @param root0.backLabel optional parent destination for Escape
 * @param root0.choices available choices
 * @param root0.onSubmit selected-value callback
 * @param root0.onCancel cancellation callback
 * @returns searchable menu
 */
export function Select<V extends string>({
  label,
  description,
  backLabel,
  choices,
  onSubmit,
  onCancel,
}: Readonly<SelectProps<V>>): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [feedback, setFeedback] = useState('');
  const matches = choices.filter((choice) =>
    `${choice.label} ${choice.description ?? ''}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const { activeCursor, visible, above, below } = choiceWindow(matches, cursor);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      return;
    }
    if (key.escape) {
      onCancel(true);

      return;
    }
    if (key.upArrow) {
      setCursor((value) => Math.max(0, value - 1));
      setFeedback('');

      return;
    }
    if (key.downArrow) {
      setCursor((value) =>
        Math.max(0, Math.min(matches.length - 1, value + 1)),
      );
      setFeedback('');

      return;
    }
    if (key.return) {
      const selected = matches[activeCursor];
      if (!selected) {
        setFeedback('No matching choices.');
      } else if (selected.disabledReason) {
        setFeedback(`Unavailable: ${selected.disabledReason}`);
      } else {
        onSubmit(selected.value);
      }

      return;
    }
    if (key.backspace || input === '\u007f') {
      setQuery((value) => value.slice(0, -1));
      setCursor(0);
      setFeedback('');

      return;
    }
    if (!key.ctrl && !key.meta && input && isPrintableInput(input)) {
      setQuery((value) => value + input);
      setCursor(0);
      setFeedback('');
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>{label}</Text>
      {description && <Text dimColor>{description}</Text>}
      <Text>Search: {query || ' '}</Text>
      {visible.map((choice) => (
        <Text dimColor={!!choice.disabledReason} key={choice.value}>
          {matches[activeCursor]?.value === choice.value ? '› ' : '  '}
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
        {matches.length} choices · ↑↓ move · Enter choose · Esc{' '}
        {backLabel ?? 'cancel'} · Ctrl+C cancel
      </Text>
    </Box>
  );
}

/**
 * presents an explicit yes/no prompt with a visible default
 * @param root0 confirmation props
 * @param root0.label prompt label
 * @param root0.description optional task context shown below the title
 * @param root0.backLabel optional parent destination for Escape
 * @param root0.defaultAnswer value accepted by Enter
 * @param root0.onSubmit answer callback
 * @param root0.onCancel cancellation callback
 * @returns confirmation prompt
 */
export function ConfirmInput({
  label,
  description,
  backLabel,
  defaultAnswer = false,
  onSubmit,
  onCancel,
}: Readonly<{
  label: string;
  description?: string;
  backLabel?: string;
  defaultAnswer?: boolean;
  onSubmit: (value: boolean) => void;
  onCancel: (back?: boolean) => void;
}>): React.JSX.Element {
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      return;
    }
    if (key.escape) {
      onCancel(true);

      return;
    }
    if (input.toLowerCase() === 'y') {
      onSubmit(true);

      return;
    }
    if (input.toLowerCase() === 'n') {
      onSubmit(false);
    } else if (key.return) {
      onSubmit(defaultAnswer);
    }
  });

  return (
    <Box flexDirection="column">
      <Text>
        {label} <Text bold>{defaultAnswer ? '[Y/n]' : '[y/N]'}</Text>
      </Text>
      {description && <Text dimColor>{description}</Text>}
      <Text dimColor>
        Y yes · N no · Enter {defaultAnswer ? 'yes' : 'no'} · Esc{' '}
        {backLabel ?? 'cancel'} · Ctrl+C cancel
      </Text>
    </Box>
  );
}

/**
 * keeps selection and scroll hints valid as search results shrink
 * @param matches current filtered choices
 * @param cursor requested selection position
 * @returns clamped position, visible choices, and hidden counts
 */
export function choiceWindow<V extends string>(
  matches: ReadonlyArray<InteractionChoice<V>>,
  cursor: number,
): ChoiceWindow<V> {
  const activeCursor = Math.max(0, Math.min(cursor, matches.length - 1));
  const above = Math.min(
    Math.max(0, activeCursor - CURSOR_CONTEXT),
    Math.max(0, matches.length - VISIBLE_CHOICES),
  );

  return {
    activeCursor,
    visible: matches.slice(above, above + VISIBLE_CHOICES),
    above,
    below: Math.max(0, matches.length - above - VISIBLE_CHOICES),
  };
}
