/** local store entry of a management credential, as a provider or network declares it; guest credentials are separate */
export type ManagementCredentialName = string;

/** explicit real store for an isolated caller; omitted means normal OS selection */
export type CredentialStoreLocation =
  | { backend: 'protected-file'; path: string }
  | { backend: 'keychain'; path: string; fallbackFilePath?: string };

/** Actual persistence backend and a fixed, non-secret fallback explanation. */
export interface CredentialSaveResult {
  storage: 'keychain' | 'protected-file';
  fallbackReason?:
    | 'Keychain is unavailable on this platform'
    | 'Keychain input cannot be stored safely'
    | 'Keychain write could not be verified';
}

/** explicit persistence choice for a local management credential */
export interface CredentialSaveOptions {
  consent: boolean;
  allowProtectedFileFallback: boolean;
  location?: CredentialStoreLocation;
}
