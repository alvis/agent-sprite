/** commit identities are independent of optional GitHub authentication */
export interface GitIdentity {
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
}
