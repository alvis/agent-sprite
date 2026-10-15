// guest kernel: constants only, with no imports, so the host can import them
// for the command entry and the state record without loading any I/O. The
// names an awake event carries and the hash a holder records

/** a harness or managed operation, as `--source` names it */
export const SOURCE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** a session identifier, as `--session` supplies it */
export const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** a hashed session identifier, as a holder or the governor records it */
export const SESSION_HASH = /^[0-9a-f]{64}$/;
