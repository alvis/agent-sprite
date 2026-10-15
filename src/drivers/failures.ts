import type { ProviderErrorCode, ProviderFailure } from './contracts.js';

/** neutral failure class and the provider's own diagnostic */
export interface ProviderFaultParams extends ErrorOptions {
  /** neutral failure class */
  code: ProviderErrorCode;
  /** provider diagnostic shown to the user unchanged */
  message: string;
}

/** provider-neutral failure a driver raises in place of a provider SDK error */
export class ProviderFault extends Error implements ProviderFailure {
  public readonly code: ProviderErrorCode;

  /**
   * records the neutral class while keeping the provider's message
   * @param params failure class, diagnostic and optional cause
   */
  constructor(params: ProviderFaultParams) {
    super(params.message, { cause: params.cause });
    this.name = 'ProviderFault';
    this.code = params.code;
  }
}
