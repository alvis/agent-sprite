import { inspect } from 'node:util';

import { rememberSecret } from '#utilities/redaction';

/**
 * where the host obtained a credential it hands to the guest; `embedded` is
 * guest file contents that hold one
 */
export type HostCredentialSource =
  | 'credential-store'
  | 'env-file'
  | 'prompt'
  | 'provider-api'
  | 'github'
  | 'embedded';

const REDACTED = '[REDACTED]';

/** the value of each secret, kept off the object so no enumeration reaches it */
const values = new WeakMap<Secret, string>();

/**
 * a credential on its way to the guest: built only from a host credential
 * source, registered for redaction, and printed, serialised and inspected as
 * a redaction marker. Only the session framing reads its value
 */
export class Secret {
  /** where the host obtained the credential */
  public readonly source: HostCredentialSource;

  /**
   * holds a credential already registered for redaction
   * @param source where the host obtained it
   * @param value the credential
   */
  private constructor(source: HostCredentialSource, value: string) {
    this.source = source;
    values.set(this, value);
  }

  /**
   * wraps a credential the host obtained from one of its sources
   * @param source where the host obtained it
   * @param value the credential
   * @returns the credential, redacted wherever it is printed
   * @throws {Error} when the credential is empty
   */
  public static fromHost(source: HostCredentialSource, value: string): Secret {
    if (value === '') {
      throw new Error(`An empty credential from ${source} cannot be sent`);
    }
    rememberSecret(value);

    return new Secret(source, value);
  }

  /**
   * wraps guest file contents that hold a credential the host resolved, such
   * as a native configuration file that embeds a gateway key; the credential
   * within is registered for redaction already, so the contents are not
   * @param contents file contents that hold a resolved credential
   * @returns the contents, delivered only as a secret
   */
  public static embedding(contents: string): Secret {
    return new Secret('embedded', contents);
  }

  /**
   * withholds the value from string conversion
   * @returns the redaction marker
   */
  public toString(): string {
    return REDACTED;
  }

  /**
   * withholds the value from serialisation
   * @returns the redaction marker
   */
  public toJSON(): string {
    return REDACTED;
  }

  /**
   * withholds the value from `util.inspect` and console output
   * @returns the source and the redaction marker
   */
  public [inspect.custom](): string {
    return `Secret(${this.source}) ${REDACTED}`;
  }
}

/**
 * reads a secret's value for delivery to the guest; only the session framing
 * calls it, and the value never leaves the session's standard input
 * @param secret a credential built by {@link Secret.fromHost}
 * @returns its value
 * @throws {Error} when the value was not built by {@link Secret.fromHost}
 */
export function revealSecret(secret: Secret): string {
  const value = values.get(secret);
  if (value === undefined) {
    throw new Error('Not a secret built from a host credential source');
  }

  return value;
}
