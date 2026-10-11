const FIRST_PRINTABLE_CODE = 32;
const DELETE_CODE = 127;

/**
 * accepts pasted printable characters while rejecting terminal control bytes
 * @param input raw Ink input chunk
 * @returns whether the chunk contains only printable characters
 */
export function isPrintableInput(input: string): boolean {
  return Array.from(input).every((character) => {
    const code = character.charCodeAt(0);

    return code >= FIRST_PRINTABLE_CODE && code !== DELETE_CODE;
  });
}
