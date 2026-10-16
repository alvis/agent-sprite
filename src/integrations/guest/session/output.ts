import { SessionTransportFault } from './faults.js';

/** output a stream keeps for one command, 4 MiB; older output is dropped first */
const OUTPUT_LIMIT_BYTES = 4_194_304;
/** an exit status has at most three digits */
const STATUS_DIGITS = 3;
const NEWLINE = 0x0a;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
/** what replaces the output a stream dropped */
const TRUNCATED_NOTE = '[earlier output truncated]\n';

/** one command's output on one stream and the status that ended it */
interface FramedOutput {
  /** marker the status line carried */
  marker: string;
  /** output before the status line, without the newline the framing added */
  output: string;
  /** exit status */
  status: number;
}

/**
 * splits one output stream of the session into per-command results: each
 * command's output ends at a line holding its marker and exit status, which
 * the framing writes after a newline of its own once the command has exited
 */
export class StatusStream {
  #buffer = Buffer.alloc(0);
  /** offset already searched for the current marker, less a needle's length */
  #searched = 0;
  #isTruncated = false;
  #ready: FramedOutput | undefined;

  /**
   * appends output the guest wrote
   * @param chunk the output
   */
  public push(chunk: Buffer | string): void {
    this.#buffer = Buffer.concat([
      this.#buffer,
      typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk,
    ]);
  }

  /**
   * takes the output that ends at a marker's status line, keeping whatever
   * follows it for the next command; repeated calls for the same marker
   * return the same result
   * @param marker the command's marker
   * @returns the output and status, or undefined until the line is complete
   * @throws {SessionTransportFault} when the status line is malformed
   */
  public take(marker: string): FramedOutput | undefined {
    if (this.#ready?.marker === marker) {
      return this.#ready;
    }
    const needle = Buffer.from(`\n${marker}`, 'utf8');
    const start = this.#buffer.indexOf(needle, this.#searched);
    if (start === -1) {
      this.#searched = Math.max(0, this.#buffer.length - needle.length);
      this.#trim();

      return undefined;
    }
    const digits = start + needle.length;
    const end = this.#buffer.indexOf(NEWLINE, digits);
    if (end === -1) {
      this.#checkDigits(digits, this.#buffer.length);
      this.#searched = start;

      return undefined;
    }
    this.#checkDigits(digits, end);
    if (end === digits) {
      throw new SessionTransportFault('The guest wrote an empty status line');
    }
    const output = this.#buffer.subarray(0, start).toString('utf8');
    this.#ready = {
      marker,
      output: this.#isTruncated ? `${TRUNCATED_NOTE}${output}` : output,
      status: Number(this.#buffer.subarray(digits, end).toString('ascii')),
    };
    this.#buffer = this.#buffer.subarray(end + 1);
    this.#searched = 0;
    this.#isTruncated = false;

    return this.#ready;
  }

  /**
   * reads the output no status line has claimed, such as what a shell that
   * never started wrote
   * @returns the output
   */
  public unclaimed(): string {
    return this.#buffer.toString('utf8');
  }

  /**
   * refuses a status that is not a short run of digits
   * @param from first byte of the status
   * @param to the byte after it
   * @throws {SessionTransportFault} when the status is malformed
   */
  #checkDigits(from: number, to: number): void {
    const status = this.#buffer.subarray(from, to);
    if (
      status.length > STATUS_DIGITS ||
      status.some((byte) => byte < DIGIT_ZERO || byte > DIGIT_NINE)
    ) {
      throw new SessionTransportFault(
        'The guest wrote a malformed status line',
      );
    }
  }

  /** drops the oldest output beyond the limit, never the part still searched */
  #trim(): void {
    const excess = this.#buffer.length - OUTPUT_LIMIT_BYTES;
    if (excess > 0) {
      this.#buffer = this.#buffer.subarray(excess);
      this.#searched = Math.max(0, this.#searched - excess);
      this.#isTruncated = true;
    }
  }
}
