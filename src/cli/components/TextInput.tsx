import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';

import { isPrintableInput } from '#cli/keystroke';

/** props for one inline text prompt */
type TextInputProps = {
  label: string;
  description?: string;
  backLabel?: string;
  defaultValue?: string;
  required?: boolean;
  secret?: boolean;
  noColor?: boolean;
  validate?: (value: string) => string | undefined;
  onSubmit: (value: string) => void;
  onCancel: (back?: boolean) => void;
};

type InputKey = Parameters<Parameters<typeof useInput>[0]>[1];

interface EditContext {
  value: string;
  cursor: number;
  required: boolean;
  validate?: (value: string) => string | undefined;
  commit: (value: string, cursor: number) => void;
  setError: (message: string) => void;
  onSubmit: (value: string) => void;
  onCancel: (back?: boolean) => void;
}

interface CharacterEditContext extends EditContext {
  characters: string[];
}

/**
 * edits Unicode text while inserting pasted chunks as data
 * @param root0 text prompt props
 * @param root0.label prompt label
 * @param root0.description optional task context shown below the title
 * @param root0.backLabel optional parent destination for Escape
 * @param root0.defaultValue initial non-secret value
 * @param root0.required whether a value is required
 * @param root0.secret whether to mask the value
 * @param root0.noColor whether color is disabled
 * @param root0.validate optional inline validation, never echoing a secret value
 * @param root0.onSubmit accepted-value callback
 * @param root0.onCancel cancellation callback
 * @returns editable prompt
 */
export function TextInput({
  label,
  description,
  backLabel,
  defaultValue = '',
  required = false,
  secret = false,
  noColor = false,
  validate,
  onSubmit,
  onCancel,
}: Readonly<TextInputProps>): React.JSX.Element {
  const [value, setValue] = useState(defaultValue);
  const [cursor, setCursor] = useState(splitGraphemes(defaultValue).length);
  const [error, setError] = useState('');
  const state = useRef({ value, cursor });
  state.current = { value, cursor };

  const commit = (nextValue: string, nextCursor: number): void => {
    state.current = { value: nextValue, cursor: nextCursor };
    setValue(nextValue);
    setCursor(nextCursor);
  };

  useInput((input, key) =>
    handleTextInput(input, key, {
      ...state.current,
      required,
      validate,
      commit,
      setError,
      onSubmit,
      onCancel,
    }),
  );

  const characters = secret ? [] : splitGraphemes(value);
  const left = characters.slice(0, cursor).join('');
  const right = characters.slice(cursor).join('');

  return (
    <Box flexDirection="column">
      <Text>
        {label}:{' '}
        {secret ? (
          '(hidden) │'
        ) : (
          <>
            {left}│{right}
          </>
        )}
      </Text>
      {description && <Text dimColor>{description}</Text>}
      {error && <Text color={noColor ? undefined : 'red'}>{error}</Text>}
      <Text dimColor>
        Enter confirm · Esc {backLabel ?? 'cancel'} · Ctrl+C cancel
      </Text>
    </Box>
  );
}

/**
 * renders a secret prompt with no visible plaintext and no history
 * @param props secret prompt props
 * @returns masked prompt
 */
export function SecretInput(
  props: Readonly<Omit<TextInputProps, 'secret' | 'defaultValue'>>,
): React.JSX.Element {
  return <TextInput {...props} secret />;
}

/**
 * applies one Ink input chunk to the current edit state
 * @param input raw input chunk
 * @param key Ink key metadata
 * @param context current edit state and callbacks
 */
function handleTextInput(
  input: string,
  key: InputKey,
  context: EditContext,
): void {
  if (handleCompletion(input, key, context)) {
    return;
  }
  const characters = splitGraphemes(context.value);
  const edit = { ...context, characters };
  if (handleMovement(input, key, edit)) {
    return;
  }
  if (handleDeletion(input, key, edit)) {
    return;
  }
  const text = input.replace(/[\r\n]/gu, '');
  if (!key.ctrl && !key.meta && text.length > 0 && isPrintableInput(text)) {
    const inserted = splitGraphemes(text);
    characters.splice(context.cursor, 0, ...inserted);
    context.commit(characters.join(''), context.cursor + inserted.length);
    context.setError('');
  }
}

/**
 * handles cancellation and submission
 * @param input raw input chunk
 * @param key Ink key metadata
 * @param context current edit state and callbacks
 * @returns whether the input was consumed
 */
function handleCompletion(
  input: string,
  key: InputKey,
  context: EditContext,
): boolean {
  if (key.ctrl && input === 'c') {
    return true;
  }
  if (key.escape) {
    context.onCancel(true);

    return true;
  }
  if (!key.return) {
    return false;
  }
  if (context.required && context.value.trim().length === 0) {
    context.setError('A value is required.');

    return true;
  }
  const validationMessage = context.validate?.(context.value);
  if (validationMessage !== undefined) {
    context.setError(validationMessage);

    return true;
  }
  context.onSubmit(context.value);

  return true;
}

/**
 * moves the edit cursor without changing the value
 * @param input raw input chunk
 * @param key Ink key metadata
 * @param context current edit state and callbacks
 * @returns whether the input was consumed
 */
function handleMovement(
  input: string,
  key: InputKey,
  context: CharacterEditContext,
): boolean {
  if (key.leftArrow || (key.ctrl && input === 'b')) {
    context.commit(context.value, Math.max(0, context.cursor - 1));
  } else if (key.rightArrow || (key.ctrl && input === 'f')) {
    context.commit(
      context.value,
      Math.min(context.characters.length, context.cursor + 1),
    );
  } else if (key.ctrl && input === 'a') {
    context.commit(context.value, 0);
  } else if (key.ctrl && input === 'e') {
    context.commit(context.value, context.characters.length);
  } else {
    return false;
  }

  return true;
}

/**
 * deletes a grapheme at or before the cursor
 * @param input raw input chunk
 * @param key Ink key metadata
 * @param context current edit state and callbacks
 * @returns whether the input was consumed
 */
function handleDeletion(
  input: string,
  key: InputKey,
  context: CharacterEditContext,
): boolean {
  if (key.backspace || input === '\u007f') {
    if (context.cursor > 0) {
      context.characters.splice(context.cursor - 1, 1);
      context.commit(context.characters.join(''), context.cursor - 1);
    }

    return true;
  }
  if (key.delete) {
    context.characters.splice(context.cursor, 1);
    context.commit(context.characters.join(''), context.cursor);

    return true;
  }

  return false;
}

/**
 * splits text at grapheme boundaries for safe editing
 * @param value text to split
 * @returns grapheme clusters
 */
function splitGraphemes(value: string): string[] {
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
    (part) => part.segment,
  );
}
