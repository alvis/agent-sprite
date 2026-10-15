// guest kernel: constants only, so host code may import it (REQ-MAINT-5)

/** the release channel of the Rust toolchain every workstation keeps */
export const RUST_CHANNEL = 'stable';

/** keeps rustup, and every proxy it provides, from fetching a toolchain as a side effect of asking for a version */
export const RUSTUP_ENVIRONMENT = ['RUSTUP_AUTO_INSTALL=0'] as const;
