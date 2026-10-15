/** Default rate limit of `POST /score`, per client. A badge refreshes at most every 10 minutes. */
export const SCORE_RATE_LIMIT = { limit: 120, windowMs: 10 * 60 * 1000 } as const;
