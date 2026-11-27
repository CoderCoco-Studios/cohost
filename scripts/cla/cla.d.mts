// Types for scripts/cla/cla.mjs, so the TypeScript tests import it checked.

export declare const SIGN_PHRASE: string;
export declare const BOT_ID: number;
export declare const MARKER: string;
export declare const BRANCH: string;
export declare const RECORD_PATH: string;
export declare const MAX_COMMITS: number;

export interface Contributor { name: string; id: number | null }
export interface Signature { name: string; id: number; comment_id: number; created_at: string; repoId: number; pullRequestNo: number }
export interface SignatureRecord { signedContributors: Signature[] }
export interface ContributorMap { signed: Contributor[]; notSigned: Contributor[]; unknown: Contributor[] }

export declare function resolveContributors(commits: unknown[]): Contributor[];
export declare function classify(contributors: Contributor[], record: SignatureRecord): ContributorMap;
export declare function formatRecord(record: SignatureRecord): string;
export declare function isSignComment(body: string | null | undefined): boolean;
export declare function safeName(name: string): string;
export declare function commentBody(map: ContributorMap, claUrl: string, totalCommits?: number): string;

export interface RunOptions {
  eventName: string;
  event: unknown;
  repository: string;
  token: string;
  apiUrl?: string;
  serverUrl?: string;
  runId?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
}
export declare function run(options: RunOptions): Promise<number>;
