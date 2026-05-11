// tests/cron/helpers/cron-fixtures.ts
//
// Shared constants and helpers for spread-refresh cron tests.
//
// Sources:
//   - ADR-0001 §"Locked-in specifics → Cron":
//       every-5-min hitting /api/cron/refresh-spreads, authenticated by CRON_SECRET header.
//   - ADR-0002 §"Error taxonomy":
//       key-missing | key-invalid | quota-exhausted | transient | other
//   - ADR-0002 §"Retry / backoff":
//       AbortController set to 8s; 6s per-user hard budget.
//   - tests/seeds/matching-queries.yaml — fixture user + question ids
//   - tests/fixtures/wire/README.md — implied_yes_prob values per platform

import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Repo root (works in both Node and compiled paths)
// ---------------------------------------------------------------------------

export const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  ""
);

// ---------------------------------------------------------------------------
// Cron route path (ADR-0001 §"Locked-in specifics → Cron")
// ---------------------------------------------------------------------------

export const CRON_ROUTE = "/api/cron/refresh-spreads";

// ---------------------------------------------------------------------------
// CRON_SECRET test value
// ---------------------------------------------------------------------------

export const TEST_CRON_SECRET = "test-cron-secret-do-not-use-in-prod";

// ---------------------------------------------------------------------------
// Expected Vercel cron schedule (ADR-0001: */5 * * * * or finer)
// ---------------------------------------------------------------------------

/** Maximum allowed interval for the Vercel Cron schedule in minutes. */
export const MAX_CRON_INTERVAL_MINUTES = 5;

// Parse a cron expression and return the minimum interval in minutes it fires.
// Only handles the simple cases we care about (step/N and specific values).
// Returns Infinity if the expression cannot be satisfied within a 24-hour window.
export function cronIntervalMinutes(expr: string): number {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return Infinity;

  const minutePart = parts[0];

  // */N — every N minutes
  const stepMatch = minutePart.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    return parseInt(stepMatch[1], 10);
  }

  // A specific minute value (e.g. "0") means once per hour (60 min)
  if (/^\d+$/.test(minutePart)) {
    const minuteValue = parseInt(minutePart, 10);
    // If minute is 0 and hour part is */N, it fires every N hours
    const hourPart = parts[1];
    const hourStep = hourPart.match(/^\*\/(\d+)$/);
    if (hourStep) {
      return parseInt(hourStep[1], 10) * 60;
    }
    // Otherwise fires once per hour = 60 min
    if (minuteValue === 0) return 60;
    return 60; // conservative
  }

  // * — every minute
  if (minutePart === "*") {
    return 1;
  }

  return Infinity;
}

// ---------------------------------------------------------------------------
// ADR-0002 error taxonomy verbatim (these exact strings are the contract)
// ---------------------------------------------------------------------------

export const WIRE_ERROR_CLASSES = {
  KEY_MISSING: "key-missing",
  KEY_INVALID: "key-invalid",
  QUOTA_EXHAUSTED: "quota-exhausted",
  TRANSIENT: "transient",
  OTHER: "other",
} as const;

export type WireErrorClass = (typeof WIRE_ERROR_CLASSES)[keyof typeof WIRE_ERROR_CLASSES];

// ---------------------------------------------------------------------------
// Fixture users (from tests/seeds/queries.yaml)
// ---------------------------------------------------------------------------

/** Primary fixture user: has an Anakin key, status = "ok". */
export const FIXTURE_USER_WITH_KEY = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "fixture@predmkt-arb.test",
  anakin_key_status: "ok" as const,
  plaintext_key: "fixture-anakin-key-for-testing-only",
} as const;

/** Secondary fixture user: no Anakin key on file, status = "key-missing". */
export const FIXTURE_USER_NO_KEY = {
  id: "00000000-0000-0000-0000-000000000002",
  email: "nokey@predmkt-arb.test",
  anakin_key_status: "key-missing" as const,
} as const;

// ---------------------------------------------------------------------------
// Fixture questions (from tests/seeds/matching-queries.yaml)
// All belong to FIXTURE_USER_WITH_KEY.
// ---------------------------------------------------------------------------

export const FIXTURE_QUESTIONS = [
  {
    id: "20000000-0000-0000-0000-000000000001",
    query_text: "Fed cuts rates June 2026",
    slug: "fed-cuts-rates-june-2026",
    user_id: FIXTURE_USER_WITH_KEY.id,
    expected_platforms: ["kalshi", "manifold", "polymarket", "robinhood"],
  },
  {
    id: "20000000-0000-0000-0000-000000000002",
    query_text: "Presidential election 2028 winner",
    slug: "presidential-election-2028",
    user_id: FIXTURE_USER_WITH_KEY.id,
    expected_platforms: ["kalshi", "manifold", "polymarket", "robinhood"],
  },
  {
    id: "20000000-0000-0000-0000-000000000003",
    query_text: "NFL Super Bowl LX winner",
    slug: "nfl-superbowl-lx",
    user_id: FIXTURE_USER_WITH_KEY.id,
    expected_platforms: ["kalshi", "manifold", "polymarket", "robinhood"],
  },
  {
    id: "20000000-0000-0000-0000-000000000004",
    query_text: "NYC mayor 2025 election",
    slug: "nyc-mayor-2025",
    user_id: FIXTURE_USER_WITH_KEY.id,
    expected_platforms: ["kalshi", "polymarket"],
  },
  {
    id: "20000000-0000-0000-0000-000000000005",
    query_text: "Oscars best picture 2027",
    slug: "oscars-best-picture-2027",
    user_id: FIXTURE_USER_WITH_KEY.id,
    expected_platforms: ["manifold", "polymarket"],
  },
] as const;

/**
 * Expected implied_yes_prob per platform for "fed-cuts-rates-june-2026".
 * Source: tests/fixtures/wire/README.md §"Implied probability values"
 *   kalshi: (42+44)/2 / 100 = 0.43
 *   manifold: 0.45
 *   polymarket: (0.39+0.41)/2 = 0.40
 *   robinhood: (0.42+0.44)/2 = 0.43
 */
export const FED_CUTS_PROBS = {
  kalshi: 0.43,
  manifold: 0.45,
  polymarket: 0.40,
  robinhood: 0.43,
} as const;

/**
 * Expected spread for "fed-cuts-rates-june-2026".
 * spread = max(0.43, 0.45, 0.40, 0.43) − min(0.43, 0.45, 0.40, 0.43)
 *        = 0.45 − 0.40 = 0.05
 */
export const FED_CUTS_SPREAD = 0.05;

// ---------------------------------------------------------------------------
// Timing constants (ADR-0002)
// ---------------------------------------------------------------------------

/**
 * Per-user AbortController budget in milliseconds (ADR-0002 §"Retry / backoff").
 * "The cron handler enforces a global AbortController set to 8 s."
 */
export const PER_USER_BUDGET_MS = 8_000;

/**
 * Idempotency window in milliseconds.
 * A second cron invocation within this window is a no-op for the user.
 * Contract: 60 seconds (documented inline in the cron handler).
 */
export const IDEMPOTENCY_WINDOW_MS = 60_000;

/**
 * quota-exhausted cooldown in milliseconds.
 * If status was set to 'quota-exhausted' at time T, cron skips until T + cooldown.
 * Contract: 10 minutes (600_000 ms).
 * Documented here and in the test that asserts it.
 *
 * Rationale: Wire quotas reset hourly per Anakin docs (ADR-0002 §"Rate-limit
 * handling"). A 10-minute cooldown ensures at most 6 retries per hour while
 * still recovering within the same hour. The implementer may increase this
 * value but must not decrease it below the 5-minute cron cadence (otherwise
 * every tick retries and the cooldown is meaningless).
 */
export const QUOTA_COOLDOWN_MS = 10 * 60_000; // 10 minutes

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

/** Return a temp path for a cron test DB. */
export function makeCronTestDbPath(suffix: string): string {
  const dir = join(tmpdir(), "predmkt-arb-cron-tests");
  return join(dir, `cron-${suffix}-${process.pid}.db`);
}

/** Encryption key used in all cron tests (32 zero bytes, base64). */
export const TEST_APP_ENCRYPTION_KEY =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

// ---------------------------------------------------------------------------
// Schema sketch for the spread_snapshots table
// ---------------------------------------------------------------------------

/**
 * Expected spread_snapshots table schema.
 * The test will assert this table exists post-implementation.
 * The implementer may use a different name or shape, but the contract
 * documented here is what QA will assert.
 *
 * Suggested Drizzle schema (informational — NOT authoritative over implementer):
 *   export const spreadSnapshots = sqliteTable("spread_snapshots", {
 *     id:          text("id").primaryKey(),
 *     questionId:  text("question_id").notNull().references(() => watchedQuestions.id),
 *     spread:      real("spread"),          // null when < 2 platforms
 *     lastUpdated: integer("last_updated", { mode: "timestamp" }).notNull(),
 *     computedAt:  integer("computed_at",  { mode: "timestamp" }).notNull(),
 *   });
 *
 * OR the implementer may extend question_matches with implied_yes_prob + last_updated,
 * and add a separate spread_snapshots that aggregates per question.
 * Either way, QA will probe both the spread value and the last_updated timestamp.
 */
export const EXPECTED_SPREAD_SNAPSHOTS_TABLE = "spread_snapshots";
export const EXPECTED_SPREAD_SNAPSHOTS_COLUMNS = [
  "id",
  "question_id",
  "spread",
  "last_updated",
  "computed_at",
] as const;
