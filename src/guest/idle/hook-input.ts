import { isRecord } from '../records.js';

import { SESSION_ID } from './names.js';

// guest kernel: imports only Node built-ins and other guest code, and names no
// provider. Harness hooks pass their event as one JSON document on standard
// input, so `--session -` reads the session identifier from it. The input is
// untrusted: it is bounded, parsed strictly and checked like `--session`

/** most bytes of hook input the command reads */
export const HOOK_INPUT_LIMIT_BYTES = 65_536;

/**
 * longest the command waits for the hook's input, in milliseconds: a harness
 * that leaves standard input open after its event must not hold its turn for
 * the whole of the command's own deadline
 */
export const HOOK_INPUT_WAIT_MS = 1_500;

/** the share of a run budget the input wait may take: a quarter */
const INPUT_WAIT_BUDGET_DIVISOR = 4;

/** what the hook input names, or why it names nothing usable */
export type HookSession =
  | {
      /** the validated session identifier */
      session: string;
    }
  | {
      /** why the input is unusable */
      refused: string;
    };

/** how a read of the hook input ended */
type ReadEnd =
  | {
      /** the input ended or held one complete document */
      text: string;
    }
  | {
      /** why the input could not be used */
      refused: string;
    };

/**
 * tells how long a command with a given run budget waits for the hook's
 * input: HOOK_INPUT_WAIT_MS, or a quarter of a shorter budget, so the holder
 * write still has most of the budget
 * @param budgetMs the command's run budget, in milliseconds
 * @returns the input wait, in milliseconds
 */
export function hookInputWaitMs(budgetMs: number): number {
  return Math.min(
    HOOK_INPUT_WAIT_MS,
    Math.floor(budgetMs / INPUT_WAIT_BUDGET_DIVISOR),
  );
}

/**
 * reads a hook's session identifier from its input stream, stopping at the
 * first complete JSON document, the size limit, the end of the input or the
 * wait limit, whichever comes first
 * @param input the stream the hook writes its event to
 * @param waitMs longest to wait for the input
 * @returns the session identifier, or the reason none could be read
 */
export async function readHookSession(
  input: AsyncIterable<Buffer | string>,
  waitMs: number = HOOK_INPUT_WAIT_MS,
): Promise<HookSession> {
  const iterator = input[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ReadEnd>((resolve) => {
    timer = setTimeout(() => {
      resolve({ refused: `hook input did not arrive within ${waitMs} ms` });
    }, waitMs);
  });
  const end = await Promise.race([collect(iterator), deadline]);
  clearTimeout(timer);
  // the stream may stay open for ever; releasing it must not be waited for
  void Promise.resolve(iterator.return?.()).catch(() => undefined);

  return 'text' in end ? parseHookSession(end.text) : end;
}

/**
 * gathers input until it is one complete JSON document or has ended
 * @param iterator the input's chunks
 * @returns the gathered text, or why it is unusable
 */
async function collect(
  iterator: AsyncIterator<Buffer | string>,
): Promise<ReadEnd> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      const bytes =
        typeof next.value === 'string' ? Buffer.from(next.value) : next.value;
      size += bytes.length;
      if (size > HOOK_INPUT_LIMIT_BYTES) {
        return {
          refused: `hook input is larger than ${HOOK_INPUT_LIMIT_BYTES} bytes`,
        };
      }
      chunks.push(bytes);
      const text = Buffer.concat(chunks).toString('utf8');
      if (isCompleteDocument(text)) {
        return { text };
      }
    }
  } catch {
    return { refused: 'hook input could not be read' };
  }

  return { text: Buffer.concat(chunks).toString('utf8') };
}

/**
 * tells whether text is already one whole JSON object
 * @param text the input read so far
 * @returns whether reading more could not change the event
 */
function isCompleteDocument(text: string): boolean {
  try {
    return isRecord(JSON.parse(text));
  } catch {
    return false;
  }
}

/**
 * extracts and validates the session identifier of a hook event
 * @param text the hook input
 * @returns the session identifier, or the reason the text does not carry one
 */
export function parseHookSession(text: string): HookSession {
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    return { refused: 'hook input is not JSON' };
  }
  if (!isRecord(event) || typeof event.session_id !== 'string') {
    return { refused: 'hook input has no session_id string' };
  }
  if (!SESSION_ID.test(event.session_id)) {
    return {
      refused:
        'hook session_id must be 1 to 128 letters, digits or ._:- characters',
    };
  }

  return { session: event.session_id };
}
