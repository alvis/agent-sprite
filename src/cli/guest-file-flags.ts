/** files that change the guest beyond the managed settings */
export const guestFileFlags = {
  envFile: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'FILE',
    brief:
      "FILE · dotenv file of variables for the agent and every shell account's shells",
  },
  setupFile: {
    kind: 'parsed',
    parse: String,
    optional: true,
    placeholder: 'FILE',
    brief:
      'FILE · executable run once as root from the guest /tmp during setup, then removed',
  },
} as const;
