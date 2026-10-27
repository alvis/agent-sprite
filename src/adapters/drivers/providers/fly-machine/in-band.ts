import { randomUUID } from 'node:crypto';

import { quoteWord } from '#adapters/guest/platform/session/framing';
import { ProviderFault } from '#kernel/provider-fault';

/** a command line for `fly ssh console -C` and the marker its status follows */
interface InBandCommand {
  /** single-quoted words the remote splitter turns back into arguments */
  line: string;
  /** unguessable marker that precedes the status line */
  marker: string;
}

/** a complete marker line found in standard error */
interface MarkerLine {
  /** the status it reports; undefined when the line is malformed */
  status: number | undefined;
  /** offset just past the line */
  end: number;
}

/**
 * runs the command, then reports its exit status on standard error after a
 * marker line; `fly ssh console` reports every non-zero remote exit as 1, so
 * this line is the only faithful status. $1 is the marker, the rest is the command
 */
const STATUS_SCRIPT =
  'marker=$1; shift; "$@"; status=$?; ' +
  'printf \'%s%d\\n\' "$marker" "$status" >&2; exit "$status"';
/** $0 of the wrapper, shown by the guest in its own diagnostics */
const WRAPPER_NAME = 'open-agent-guest';
const MARKER_PREFIX = '@@open-agent-status:';
const NEWLINE = 0x0a;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
/** an exit status has at most three digits */
const STATUS_DIGITS = 3;
const MAX_STATUS = 255;
/**
 * text after the latest marker line is held back as the transport's own
 * report of the exit; beyond this much it cannot be, so it is released
 */
const TRAILER_LIMIT_BYTES = 65_536;
const TRANSPORT_DIAGNOSTIC_LENGTH = 300;

/**
 * wraps a program and its arguments so the guest reports the exit status in
 * band; every word is single-quoted, so no guest shell interprets it
 * @param words program followed by its arguments
 * @returns the command line and its marker
 */
export function inBandCommand(words: readonly string[]): InBandCommand {
  const marker = `${MARKER_PREFIX}${randomUUID()}:`;
  const line = ['/bin/sh', '-c', STATUS_SCRIPT, WRAPPER_NAME, marker, ...words]
    .map(quoteWord)
    .join(' ');

  return { line, marker };
}

/**
 * separates a command's own standard error from the status lines that carry
 * its marker; every marker line is removed and the last one decides the
 * status, because the wrapper writes its line after the command has exited,
 * so a command that learns its marker can only print a line the real one
 * follows. Text after the last marker line is the transport's own report of
 * the exit and is discarded; text between marker lines is the command's own
 */
export class InBandStatusFilter {
  readonly #marker: Buffer;
  /** bytes not yet classified */
  #pending = Buffer.alloc(0);
  /** text after the latest marker line, held back as a possible trailer */
  #trailer = Buffer.alloc(0);
  #seen = false;
  #status: number | undefined;

  /**
   * binds the filter to one invocation's marker
   * @param marker marker returned with the command line
   */
  constructor(marker: string) {
    this.#marker = Buffer.from(marker);
  }

  /**
   * the status the last marker line reported; undefined when no marker line
   * arrived or the last one was malformed or out of range
   * @returns exit status from 0 to 255
   */
  public get status(): number | undefined {
    return this.#status;
  }

  /**
   * consumes standard error bytes
   * @param chunk bytes the guest wrote
   * @returns bytes that belong to the command's own standard error
   */
  public push(chunk: Buffer): Buffer {
    this.#pending = Buffer.concat([this.#pending, chunk]);

    return this.#drain(false);
  }

  /**
   * ends the stream, discarding whatever followed the last marker line
   * @returns held bytes that turned out not to begin a marker
   */
  public end(): Buffer {
    const rest = this.#drain(true);
    this.#trailer = Buffer.alloc(0);

    return rest;
  }

  /**
   * classifies the pending bytes as far as they can be decided
   * @param ended whether the stream has ended, which completes every line
   * @returns the command's own standard error released by this step
   */
  #drain(ended: boolean): Buffer {
    const released: Buffer[] = [];
    for (;;) {
      const index = this.#pending.indexOf(this.#marker);
      if (index === -1) {
        const kept = ended ? 0 : this.#partialMarkerLength();
        released.push(
          this.#text(this.#pending.subarray(0, this.#pending.length - kept)),
        );
        this.#pending = this.#pending.subarray(this.#pending.length - kept);

        return Buffer.concat(released);
      }
      const line = this.#readLine(index + this.#marker.length, ended);
      if (!line) {
        return Buffer.concat(released);
      }
      const before = this.#pending.subarray(0, index);
      released.push(this.#trailer, before);
      this.#trailer = Buffer.alloc(0);
      this.#seen = true;
      this.#status = line.status;
      this.#pending = this.#pending.subarray(line.end);
    }
  }

  /**
   * reads the status after a marker
   * @param start offset just past the marker
   * @param ended whether the stream has ended
   * @returns the line, or undefined while it is still incomplete
   */
  #readLine(start: number, ended: boolean): MarkerLine | undefined {
    let cursor = start;
    while (
      cursor < this.#pending.length &&
      cursor - start < STATUS_DIGITS &&
      isDigit(this.#pending[cursor])
    ) {
      cursor += 1;
    }
    const digits = this.#pending.subarray(start, cursor).toString('ascii');
    if (cursor === this.#pending.length) {
      return ended ? { status: exitStatus(digits), end: cursor } : undefined;
    }
    if (this.#pending[cursor] === NEWLINE) {
      return { status: exitStatus(digits), end: cursor + 1 };
    }

    // a fourth digit or any other byte makes the line malformed
    return { status: undefined, end: cursor };
  }

  /**
   * routes text that is not a marker line: before any marker it is the
   * command's own, after one it is held until another marker line proves it
   * was the command's too
   * @param text classified bytes
   * @returns bytes released now
   */
  #text(text: Buffer): Buffer {
    if (!this.#seen) {
      return text;
    }
    this.#trailer = Buffer.concat([this.#trailer, text]);
    if (this.#trailer.length <= TRAILER_LIMIT_BYTES) {
      return Buffer.alloc(0);
    }
    const released = this.#trailer;
    this.#trailer = Buffer.alloc(0);

    return released;
  }

  /**
   * measures the longest end of the pending bytes that could begin a marker
   * @returns how many trailing bytes to hold back
   */
  #partialMarkerLength(): number {
    const data = this.#pending;
    const longest = Math.min(data.length, this.#marker.length - 1);
    for (let length = longest; length > 0; length--) {
      const tail = data.subarray(data.length - length);
      if (tail.equals(this.#marker.subarray(0, length))) {
        return length;
      }
    }

    return 0;
  }
}

/**
 * splits a complete standard error into the command's own text and its status
 * @param stderr everything the guest wrote to standard error
 * @param marker marker returned with the command line
 * @returns the command's standard error and the reported status, if any
 */
export function splitInBandStatus(
  stderr: Buffer,
  marker: string,
): { stderr: Buffer; status: number | undefined } {
  const filter = new InBandStatusFilter(marker);
  const own = Buffer.concat([filter.push(stderr), filter.end()]);

  return { stderr: own, status: filter.status };
}

/**
 * accepts the in-band status only when flyctl's own exit agrees with it:
 * flyctl exits 0 exactly when the remote command did, so a missing status or
 * a disagreement means the session, not the command, decided the outcome
 * @param status status the last marker line reported
 * @param transportExit flyctl's own exit code; null when a signal ended it
 * @param transport flyctl's standard error, for the diagnostic
 * @returns the command's exit status
 */
export function verifiedStatus(
  status: number | undefined,
  transportExit: number | null | undefined,
  transport: string,
): number {
  const exit = transportExit ?? 'by signal';
  if (status === undefined) {
    throw sessionFault(
      `ended before the guest reported a status (flyctl exited ${exit})`,
      transport,
    );
  }
  if ((status === 0) !== (transportExit === 0)) {
    throw sessionFault(
      `reported status ${status} while flyctl exited ${exit}`,
      transport,
    );
  }

  return status;
}

/**
 * describes a session whose outcome cannot be trusted
 * @param what what went wrong
 * @param transport flyctl's standard error
 * @returns a transient provider fault
 */
function sessionFault(what: string, transport: string): ProviderFault {
  const diagnostic = transport.trim().slice(-TRANSPORT_DIAGNOSTIC_LENGTH);
  const detail = diagnostic === '' ? '' : `: ${diagnostic}`;

  return new ProviderFault({
    code: 'transient',
    message: `The SSH session ${what}${detail}`,
  });
}

/**
 * reads an exit status from its decimal digits
 * @param digits at most three decimal digits
 * @returns the status, or undefined when absent or above 255
 */
function exitStatus(digits: string): number | undefined {
  const status = digits === '' ? Number.NaN : Number(digits);

  return status <= MAX_STATUS ? status : undefined;
}

/**
 * tells whether a byte is an ASCII decimal digit
 * @param byte byte to test; undefined past the end
 * @returns true for 0 to 9
 */
function isDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= DIGIT_ZERO && byte <= DIGIT_NINE;
}
