/**
 * Anchor payload builders, one per contract major.
 *
 * The anchor invariant: a plain approve on a PR under 400 weighted lines balances one PR under
 * 400 weighted lines of my own, at the same age, at exactly ratio 1.0. Every supported major must
 * be able to express it, and the server must score it at 1.0.
 */
export interface AnchorInput {
  /** ISO timestamp, rounded to the hour. Used for both the review and the ready-for-review time. */
  at: string;
  /** Lines of each side, rounded to 10. */
  lines: number;
}

export const ANCHOR_BUILDERS: Readonly<Record<number, (input: AnchorInput) => unknown>> = {
  1: ({ at, lines }) => ({
    contractVersion: 1,
    up: [
      {
        t: at,
        action: 'approve',
        linesByClass: { production: lines },
        commentedLinesByClass: {},
        viewedLinesByClass: {},
        waitedHoursWithoutReview: 0,
      },
    ],
    down: [
      {
        prKey: '0f6f9a1e-5a7d-4c1b-9d2e-2b1d8c3f4a5b',
        readyAt: at,
        linesByClass: { production: lines },
      },
    ],
  }),
};
