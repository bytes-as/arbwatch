/**
 * tests/watched/helpers/fixture-watched.ts
 *
 * Shared constants for watched-question CRUD tests.
 *
 * Sources:
 *   - tests/seeds/queries.yaml        — fixture user ids and seed questions
 *   - docs/design/dashboard.md §5B    — cap-reached inline message (locked copy)
 *   - docs/design/dashboard.md §5C    — empty-state copy (locked copy)
 *   - docs/design/dashboard.md §5A    — page-level copy
 *   - db/schema.ts                    — watched_questions table shape
 */

// ---------------------------------------------------------------------------
// Fixture users (mirror of tests/seeds/queries.yaml)
// ---------------------------------------------------------------------------

/** Primary fixture user: has an Anakin key, status = "ok". */
export const FIXTURE_USER_A = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "fixture@predmkt-arb.test",
  anakin_key_status: "ok" as const,
} as const;

/** Secondary fixture user: no Anakin key, status = "key-missing". */
export const FIXTURE_USER_B = {
  id: "00000000-0000-0000-0000-000000000002",
  email: "nokey@predmkt-arb.test",
  anakin_key_status: "key-missing" as const,
} as const;

// ---------------------------------------------------------------------------
// Session tokens (must match the seed)
// ---------------------------------------------------------------------------

/** Session token for user A — seeded into the test DB. */
export const SESSION_A =
  process.env.FIXTURE_SESSION_TOKEN ?? "fixture-session-token-do-not-use-in-prod";

/** Session token for user B — seeded into the test DB. */
export const SESSION_B =
  process.env.FIXTURE_SESSION_TOKEN_B ?? "fixture-session-token-b-do-not-use-in-prod";

// ---------------------------------------------------------------------------
// Seed questions from tests/seeds/queries.yaml
// Seeded for FIXTURE_USER_A only. Count = 3 (below the 5-cap).
// ---------------------------------------------------------------------------

export const SEED_QUESTIONS = [
  {
    id: "10000000-0000-0000-0000-000000000001",
    query_text: "Will the Fed raise interest rates in 2026?",
    user_id: FIXTURE_USER_A.id,
  },
  {
    id: "10000000-0000-0000-0000-000000000002",
    query_text: "Will the US enter a recession by end of 2026?",
    user_id: FIXTURE_USER_A.id,
  },
  {
    id: "10000000-0000-0000-0000-000000000003",
    query_text: "Will a major AI lab release a model surpassing GPT-5 in 2026?",
    user_id: FIXTURE_USER_A.id,
  },
] as const;

/**
 * Two extra questions used to top-up user A to exactly 5, for cap-enforcement tests.
 * These are inserted programmatically in test setup (not in the seed yaml).
 * Stable IDs are used so the test can reference them for delete operations.
 *
 * Strategy: programmatic insertion in beforeAll — chosen over extending the seed
 * yaml because the 5-cap tests need a user at exactly 5 questions, and changing
 * the yaml baseline would break any test that asserts "3 questions in baseline".
 */
export const CAP_TOPUP_QUESTIONS = [
  {
    id: "10000000-0000-0000-0000-000000000004",
    query_text: "Will SpaceX land humans on Mars before 2030?",
    user_id: FIXTURE_USER_A.id,
  },
  {
    id: "10000000-0000-0000-0000-000000000005",
    query_text: "Will the US national debt exceed $40 trillion in 2026?",
    user_id: FIXTURE_USER_A.id,
  },
] as const;

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

export const WATCHED_ROUTES = {
  /** List the authenticated user's watched questions */
  list: "/api/watched",
  /** Add a new watched question */
  add: "/api/watched",
  /** Remove a watched question by id — append the id: /api/watched/:id */
  deletePrefix: "/api/watched",
} as const;

// ---------------------------------------------------------------------------
// Input validation constants
// ---------------------------------------------------------------------------

/**
 * Maximum allowed query_text length (characters).
 * Rationale: Twitter precedent — 280 chars is a well-established "short-form
 * text" limit the user base will recognise. The test asserts a 281-char input
 * is rejected with 400. The implementer should enforce this in the route handler
 * and document it in the API surface.
 */
export const MAX_QUERY_TEXT_LENGTH = 280;

// ---------------------------------------------------------------------------
// UX-spec'd copy strings (locked — tests assert these exact strings)
// Source: docs/design/dashboard.md §5B, §5C, §5A
// ---------------------------------------------------------------------------

/**
 * Cap-reached inline message.
 * Source: docs/design/dashboard.md §5B ("Cap-reached inline message")
 *   "You've reached the 5-question limit. Remove a question to add a new one."
 * Rendered in a <p id="cap-message"> below the form.
 * This string is asserted by:
 *   - Backend test: 400 response body on 6th POST (DoD item 4)
 *   - Playwright test: cap-reached UI (DoD item 12)
 */
export const CAP_EXCEEDED_MESSAGE =
  "You've reached the 5-question limit. Remove a question to add a new one.";

/**
 * Empty-state heading.
 * Source: docs/design/dashboard.md §5C ("Empty-state heading")
 *   "You're not watching any questions yet."
 * Asserted by Playwright test DoD item 13.
 */
export const EMPTY_STATE_HEADING = "You're not watching any questions yet.";

/**
 * Empty-state subtext.
 * Source: docs/design/dashboard.md §5C ("Empty-state subtext")
 *   "Type a question above to start tracking spreads."
 * Asserted by Playwright test DoD item 13.
 */
export const EMPTY_STATE_SUBTEXT = "Type a question above to start tracking spreads.";

/**
 * Page <h1> text.
 * Source: docs/design/dashboard.md §5A
 *   "<h1>: "Watched questions""
 */
export const PAGE_HEADING = "Watched questions";

/**
 * Add-form submit button label (idle).
 * Source: docs/design/dashboard.md §5B
 *   "Submit button (idle): "Watch question""
 */
export const SUBMIT_BUTTON_LABEL = "Watch question";

/**
 * Add-form input label (accessible, may be visually hidden).
 * Source: docs/design/dashboard.md §5B
 *   "Input label (visually hidden, not a visible placeholder): "Watch a new question""
 */
export const INPUT_LABEL = "Watch a new question";

/**
 * Remove button label on each question row.
 * Source: docs/design/dashboard.md §5C
 *   "Remove button: "Remove""
 */
export const REMOVE_BUTTON_LABEL = "Remove";

/**
 * Page <title>.
 * Source: docs/design/dashboard.md §5A
 *   "Page <title>: "Dashboard — ArbWatch""
 */
export const PAGE_TITLE = "Dashboard — ArbWatch";
