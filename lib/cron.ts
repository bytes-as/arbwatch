/**
 * lib/cron.ts
 *
 * Helpers for the spread-refresh cron job (ADR-0001, ADR-0002).
 * Exported for unit testing.
 */

export const QUOTA_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
export const IDEMPOTENCY_WINDOW_MS = 60_000; // 60 seconds
export const PER_USER_BUDGET_MS = 8_000; // 8 seconds

// 7-day display window + 1-day buffer so a brief cron outage does not
// immediately expose a gap at the left edge of the sparkline.
export const HISTORY_RETENTION_DAYS = 8;

/**
 * Compute the spread across platforms.
 * Returns null when fewer than 2 probs are provided (no meaningful spread).
 * Returns max(probs) - min(probs) otherwise.
 */
export function computeSpreadForQuestion(platformProbs: number[]): number | null {
  if (platformProbs.length < 2) return null;
  const max = Math.max(...platformProbs);
  const min = Math.min(...platformProbs);
  return max - min;
}

interface UserRow {
  anakin_key_status: string;
  anakin_key_status_at: number | null;
}

/**
 * Returns true if the cron should skip this user this tick.
 * nowMs is Date.now() at the start of the tick.
 */
export function shouldSkipUser(user: UserRow, nowMs: number): boolean {
  const status = user.anakin_key_status;

  if (status === "key-missing" || status === "key-invalid") {
    return true;
  }

  if (status === "quota-exhausted") {
    const statusAtMs = (user.anakin_key_status_at ?? 0) * 1000;
    if (nowMs < statusAtMs + QUOTA_COOLDOWN_MS) {
      return true;
    }
  }

  return false;
}

/**
 * Returns true if the user was refreshed recently (within idempotency window).
 * lastUpdatedSec is the Unix timestamp (seconds) of the most recent spread_snapshot for this user.
 */
export function isWithinIdempotencyWindow(
  lastUpdatedSec: number | null,
  nowMs: number
): boolean {
  if (lastUpdatedSec === null) return false;
  return nowMs - lastUpdatedSec * 1000 < IDEMPOTENCY_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Per-invocation idempotency set (keyed by "dbUrl:questionId")
// Cleared between tests via clearIdempotencyCache() called in beforeEach.
// In production (single-process), cleared implicitly when the process restarts.
// ---------------------------------------------------------------------------

const _processedKeys = new Set<string>();

/**
 * Clear the idempotency cache. Called by the test setup before each test.
 */
export function clearIdempotencyCache(): void {
  _processedKeys.clear();
}

/**
 * Mark a question as having been processed with actual Wire calls in the current run.
 */
export function markQuestionProcessed(dbUrl: string, questionId: string): void {
  _processedKeys.add(`${dbUrl}:${questionId}`);
}

/**
 * Returns true if this question was already processed with Wire calls in the current run.
 */
export function isQuestionProcessed(dbUrl: string, questionId: string): boolean {
  return _processedKeys.has(`${dbUrl}:${questionId}`);
}
