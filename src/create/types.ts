/** verified caller-side checks and actionable guest-readiness reminders */
export interface CreatePreflight {
  checks: string[];
  reminders: string[];
}
