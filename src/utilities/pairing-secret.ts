import {
  redactForPairing,
  redactResolved,
  rememberSecret,
} from './redaction.js';

/** native pairing material and optional provider connection URL */
export interface PairingSecretParams {
  token: string;
  url?: string;
}

/** runtime marker for a genuine native pairing code or its associated URL */
export class PairingSecret {
  readonly #token: string;
  readonly #url?: string;

  /**
   * marks pairing material independently of its output field name
   * @param params native pairing code and optional provider connection URL
   * @param params.token native pairing code
   * @param params.url optional provider connection URL
   */
  constructor({ token, url }: PairingSecretParams) {
    this.#token = token;
    this.#url = url;
    rememberSecret(token);
  }

  /**
   * attaches this code to a provider URL under the same disclosure permission
   * @param url provider URL
   * @returns marked pairing URL
   */
  public forUrl(url: string): PairingSecret {
    return new PairingSecret({ token: this.#token, url });
  }

  /**
   * resolves only this marked material, retaining all other credential redaction
   * @param permitted whether the caller granted pairing disclosure
   * @returns printable code or URL, or no code when disclosure is withheld
   */
  public disclose(permitted: boolean): string | undefined {
    if (!permitted) {
      return this.#url === undefined ? undefined : redactResolved(this.#url);
    }
    const token = redactForPairing(this.#token, this.#token);

    return this.#url === undefined
      ? token
      : new URL(
          `#token=${encodeURIComponent(token)}`,
          redactResolved(this.#url),
        ).toString();
  }

  /**
   * withholds pairing material outside the explicit output boundary
   * @returns safe default for accidental serialization
   */
  public toJSON(): string | undefined {
    return this.disclose(false);
  }
}
