/** guest account a command or service runs as */
export type GuestAccount = 'root' | 'agent';

/** one command run on the guest */
export interface GuestCommand {
  /** absolute path or name of the program */
  program: string;
  /** program arguments */
  arguments: readonly string[];
  /** account the command runs as; root by default */
  account?: GuestAccount;
  /** additional environment variables */
  environment?: Readonly<Record<string, string>>;
  /** standard input written before the input closes */
  input?: string;
  /** upper bound before the command is abandoned */
  timeoutMs?: number;
}
