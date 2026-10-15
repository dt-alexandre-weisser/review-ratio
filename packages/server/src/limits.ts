/** The rate limit window of `POST /score`. */
export const SCORE_RATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Default requests per client and window. A badge refreshes at most once per window, plus a few
 * manual refreshes; the default leaves room for about 200 developers behind one office address.
 * Set `RATE_LIMIT_PER_10_MIN` to size it for the network in front of the server.
 */
export const DEFAULT_SCORE_RATE_LIMIT = 600;

export const SCORE_RATE_LIMIT = {
  limit: DEFAULT_SCORE_RATE_LIMIT,
  windowMs: SCORE_RATE_WINDOW_MS,
} as const;
