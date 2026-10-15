/** The slices of the GitHub API the extension reads. Field names follow GitHub's. */

export interface Viewer {
  login: string;
}

/** One item of `GET /search/issues` filtered to pull requests. */
export interface SearchPullRequest {
  number: number;
  /** `https://api.github.com/repos/{owner}/{repo}` */
  repository_url: string;
  draft: boolean;
  updated_at: string;
}

export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';
export type ReviewState = 'PENDING' | 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED';
export type ViewedState = 'VIEWED' | 'UNVIEWED' | 'DISMISSED';
export type ActorType = 'User' | 'Bot' | 'Mannequin' | 'Organization' | 'EnterpriseUserAccount';

export interface Actor {
  login: string;
  type: ActorType;
}

export interface PullRequestFile {
  path: string;
  additions: number;
  deletions: number;
  viewerViewedState: ViewedState;
}

export interface ReviewComment {
  path: string;
  /** Current line, `null` when the comment is outdated. */
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  /** Set when the comment answers another comment. */
  isReply: boolean;
  /** GitHub's `databaseId` of the comment, only used to dedupe. */
  id: string;
}

export interface Review {
  /** GraphQL node id. Stable; used to key the Viewed snapshots. */
  id: string;
  author: Actor | null;
  state: ReviewState;
  submittedAt: string | null;
  /** The PR head commit the review was submitted against. */
  commitOid: string | null;
  body: string;
  comments: ReviewComment[];
}

/** Everything the collectors need about one PR, from one GraphQL query. */
export interface PullRequestDetails {
  owner: string;
  repo: string;
  number: number;
  state: PullRequestState;
  isDraft: boolean;
  author: Actor | null;
  assignees: string[];
  createdAt: string;
  /** Merge or close time. */
  closedAt: string | null;
  headRefOid: string;
  /** Tip of the base branch. Compared with three dots, it yields the PR's own changes. */
  baseRefOid: string;
  /** When the PR was last marked ready for review; `null` when it never was a draft. */
  readyForReviewAt: string | null;
  files: PullRequestFile[];
  reviews: Review[];
}

/** One file of `GET /repos/{o}/{r}/compare/{base}...{head}`. */
export interface CompareFile {
  filename: string;
  changes: number;
}

export interface GitHubClient {
  viewer(): Promise<Viewer>;
  /** Pull requests matching a search query, all pages. */
  searchPullRequests(query: string): Promise<SearchPullRequest[]>;
  pullRequest(owner: string, repo: string, number: number): Promise<PullRequestDetails>;
  /**
   * Files changed between two commit SHAs (three-dot, so from their merge base), or `null` when
   * GitHub cannot compare them any more (force-push, garbage-collected commit).
   */
  compare(owner: string, repo: string, base: string, head: string): Promise<CompareFile[] | null>;
}
