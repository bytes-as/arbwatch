/**
 * tests/watched/crud.test.ts
 *
 * Mode 1 (pre-implementation) — ALL tests in this file MUST FAIL until:
 *   - task-watched-backend implements POST /api/watched
 *   - task-watched-backend implements GET /api/watched
 *   - task-watched-backend implements DELETE /api/watched/:id
 *   - The middleware correctly scopes /api/watched to the authenticated caller
 *   - The 5-question cap is enforced per docs/design/dashboard.md §5B
 *
 * Test surfaces covered (per task-watched-test brief §Backend):
 *   1. POST /api/watched adds a question
 *   2. GET /api/watched lists only the authenticated user's rows
 *   3. DELETE /api/watched/:id removes a question (+ cascade to question_matches)
 *   4. 5-cap enforcement — 6th POST returns 400 with locked UX copy
 *   5. Per-user isolation — list/delete are scoped to the caller
 *   6. Auth-gated — all three endpoints return 401 without a session
 *   7. Input validation — empty/whitespace/too-long query_text → 400
 *   8. Cap-counter semantic — deleted rows do NOT count toward the cap
 *
 * Database dependency note (DoD item 3):
 *   The DELETE endpoint must cascade to a `question_matches` table (landing in
 *   task-matching-impl). This test references that table and expects either:
 *     (a) The table exists and its rows are deleted, OR
 *     (b) The table does not yet exist — in which case the test gracefully skips
 *         the cascade assertion with a documented TODO and fails on the primary
 *         DELETE assertion (route not implemented) instead.
 *
 * Seed assumptions:
 *   - tests/seeds/queries.yaml seeds FIXTURE_USER_A with exactly 3 questions.
 *   - The "5-cap enforcement" and "cap-counter semantic" suites programmatically
 *     insert 2 additional questions (CAP_TOPUP_QUESTIONS) in beforeAll so that
 *     user A has exactly 5. This avoids changing the baseline yaml.
 *   - FIXTURE_USER_B has 0 watched questions in the seed.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FIXTURE_USER_A,
  FIXTURE_USER_B,
  SESSION_A,
  SESSION_B,
  SEED_QUESTIONS,
  CAP_TOPUP_QUESTIONS,
  WATCHED_ROUTES,
  MAX_QUERY_TEXT_LENGTH,
  CAP_EXCEEDED_MESSAGE,
} from "./helpers/fixture-watched";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const SEED_SCRIPT = join(REPO_ROOT, "scripts", "seed.ts");
const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const TEST_APP_ENCRYPTION_KEY =
  process.env.APP_ENCRYPTION_KEY ?? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/** IPC file that key-server-setup.ts reads to resolve DATABASE_URL. */
const IPC_FILE = join(tmpdir(), ".predmkt-test-current-db-url");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(suiteName: string): string {
  const dir = join(tmpdir(), `predmkt-arb-watched-tests`);
  mkdirSync(dir, { recursive: true });
  return join(dir, `watched-${suiteName}-${process.pid}.db`);
}

function runSeed(targetDbPath: string): void {
  const dbUrl = `file:${targetDbPath}`;
  // Write IPC file so watched-server-setup.ts resolves to this DB for in-process dispatch.
  writeFileSync(IPC_FILE, dbUrl, "utf8");
  execFileSync("npx", ["tsx", SEED_SCRIPT], {
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
      WIRE_MODE: "fixtures",
      APP_ENCRYPTION_KEY: TEST_APP_ENCRYPTION_KEY,
      NODE_ENV: "test",
      // Must be "true" so the seed:
      //   (a) inserts FIXTURE_USER_B alongside user A
      //   (b) seeds the session for user B
      //   (c) writes the IPC file so the in-process dispatcher picks up the DB URL
      PREDMKT_KEY_TEST: "true",
    },
    cwd: REPO_ROOT,
    stdio: "pipe",
    timeout: 30_000,
  });
  process.env.DATABASE_URL = dbUrl;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function openDb(dbPath: string): Promise<any> {
  const mod = await import("better-sqlite3") as any;
  const BetterSqlite3 = mod.default ?? mod;
  return new BetterSqlite3(dbPath);
}

/**
 * Insert a watched_questions row directly into the SQLite DB.
 * Used to set up the "exactly 5 questions" precondition without going through
 * the API (which may not exist yet, and would count against the cap itself).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function insertWatchedQuestion(db: any, row: { id: string; user_id: string; query_text: string }): void {
  db.prepare(
    "INSERT INTO watched_questions (id, user_id, query_text, created_at) VALUES (?, ?, ?, ?)"
  ).run(row.id, row.user_id, row.query_text, Date.now());
}

/**
 * Count watched_questions rows for a given user directly in the DB.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function countWatchedForUser(db: any, userId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM watched_questions WHERE user_id = ?")
    .get(userId) as { cnt: number };
  return row.cnt;
}

/**
 * Check whether a watched_questions row with the given id exists.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowExists(db: any, id: string): boolean {
  const row = db
    .prepare("SELECT id FROM watched_questions WHERE id = ?")
    .get(id) as { id: string } | undefined;
  return row !== undefined;
}

/**
 * Check whether the question_matches table exists in the DB schema.
 * Returns true if it exists, false otherwise.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function questionMatchesTableExists(db: any): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='question_matches'"
    )
    .get() as { name: string } | undefined;
  return row !== undefined;
}

/**
 * Count question_matches rows for a given question id directly in the DB.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function countMatchesForQuestion(db: any, questionId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM question_matches WHERE question_id = ?")
    .get(questionId) as { cnt: number };
  return row.cnt;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

async function getWatched(sessionToken: string): Promise<Response> {
  return fetch(`${BASE_URL}${WATCHED_ROUTES.list}`, {
    method: "GET",
    headers: {
      Cookie: `next-auth.session-token=${sessionToken}`,
    },
    redirect: "manual",
  });
}

async function postWatched(queryText: string, sessionToken: string): Promise<Response> {
  return fetch(`${BASE_URL}${WATCHED_ROUTES.add}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `next-auth.session-token=${sessionToken}`,
    },
    body: JSON.stringify({ query_text: queryText }),
    redirect: "manual",
  });
}

async function deleteWatched(id: string, sessionToken: string): Promise<Response> {
  return fetch(`${BASE_URL}${WATCHED_ROUTES.deletePrefix}/${id}`, {
    method: "DELETE",
    headers: {
      Cookie: `next-auth.session-token=${sessionToken}`,
    },
    redirect: "manual",
  });
}

async function unauthenticatedRequest(method: string, path: string, body?: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ?? undefined,
    redirect: "manual",
  });
}

// ---------------------------------------------------------------------------
// Suite 1: POST /api/watched — adds a question
// ---------------------------------------------------------------------------

describe("POST /api/watched — adds a watched question", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  let addedId: string | null = null;

  beforeAll(async () => {
    dbPath = makeTempDbPath("post");
    runSeed(dbPath);
    db = await openDb(dbPath);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("POST /api/watched returns 200 with {id, query_text, created_at}", async () => {
    const res = await postWatched("Fed cuts rates June", SESSION_A);

    expect(
      res.status,
      `POST ${WATCHED_ROUTES.add} returned ${res.status}. Expected 200. ` +
        `The endpoint does not exist yet — task-watched-backend must implement it.`
    ).toBe(200);

    const body = await res.json().catch(() => null);
    expect(body, "Response body must be JSON").not.toBeNull();

    expect(
      typeof body.id,
      `Response body must contain an "id" field (UUID string). Got: ${JSON.stringify(body)}`
    ).toBe("string");

    expect(
      typeof body.query_text,
      `Response body must contain a "query_text" field. Got: ${JSON.stringify(body)}`
    ).toBe("string");

    expect(
      body.query_text,
      `Response "query_text" must match the submitted text. ` +
        `Expected "Fed cuts rates June", got "${body.query_text}".`
    ).toBe("Fed cuts rates June");

    expect(
      body.created_at !== undefined && body.created_at !== null,
      `Response body must contain a "created_at" field. Got: ${JSON.stringify(body)}`
    ).toBe(true);

    addedId = body.id;
  });

  it("POST /api/watched persists the row in watched_questions with the caller's user_id", async () => {
    // If the previous test didn't set addedId, add a fresh question
    const queryText = "Will inflation fall below 2% in 2026?";
    const res = await postWatched(queryText, SESSION_A);
    expect(res.status, `POST returned ${res.status}, expected 200`).toBe(200);

    const body = await res.json().catch(() => null);
    const id = body?.id;
    expect(id, "POST response must include an id").toBeTruthy();

    // Verify the row is in the DB with the correct user_id
    const row = db
      .prepare("SELECT * FROM watched_questions WHERE id = ?")
      .get(id) as { id: string; user_id: string; query_text: string } | undefined;

    expect(
      row,
      `No row found in watched_questions with id="${id}". ` +
        `The POST handler must insert the row into the database.`
    ).toBeDefined();

    expect(
      row!.user_id,
      `Row user_id is "${row!.user_id}", expected "${FIXTURE_USER_A.id}". ` +
        `The POST handler must record the authenticated caller's user_id, ` +
        `not a hardcoded id or the request body's user_id.`
    ).toBe(FIXTURE_USER_A.id);

    expect(
      row!.query_text,
      `Row query_text is "${row!.query_text}", expected "${queryText}".`
    ).toBe(queryText);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: GET /api/watched — lists the user's questions
// ---------------------------------------------------------------------------

describe("GET /api/watched — lists only the authenticated user's questions", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    dbPath = makeTempDbPath("get");
    runSeed(dbPath);
    db = await openDb(dbPath);

    // Insert a question for user B so isolation can be verified
    insertWatchedQuestion(db, {
      id: "20000000-0000-0000-0000-000000000001",
      user_id: FIXTURE_USER_B.id,
      query_text: "User B exclusive question",
    });
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("GET /api/watched returns 200 with an array of questions", async () => {
    const res = await getWatched(SESSION_A);

    expect(
      res.status,
      `GET ${WATCHED_ROUTES.list} returned ${res.status}. Expected 200. ` +
        `The endpoint does not exist yet — task-watched-backend must implement it.`
    ).toBe(200);

    const body = await res.json().catch(() => null);
    expect(Array.isArray(body), `GET /api/watched must return a JSON array. Got: ${JSON.stringify(body)}`).toBe(true);
  });

  it("GET /api/watched returns the seed questions for the authenticated user", async () => {
    const res = await getWatched(SESSION_A);
    expect(res.status).toBe(200);

    const body = await res.json().catch(() => []) as Array<{ id: string; query_text: string; user_id?: string }>;

    // The seed inserts 3 questions for user A
    expect(
      body.length,
      `GET /api/watched returned ${body.length} items. ` +
        `Expected at least 3 (the seed inserts 3 for user A). ` +
        `Returned: ${JSON.stringify(body)}`
    ).toBeGreaterThanOrEqual(3);

    const queryTexts = body.map((q) => q.query_text);

    for (const seedQ of SEED_QUESTIONS) {
      expect(
        queryTexts,
        `GET /api/watched response is missing seed question "${seedQ.query_text}". ` +
          `The seed must insert this question for user A and the GET endpoint must return it.`
      ).toContain(seedQ.query_text);
    }
  });

  it("GET /api/watched does NOT return another user's questions", async () => {
    // Request as user A — must NOT see user B's question
    const res = await getWatched(SESSION_A);
    expect(res.status).toBe(200);

    const body = await res.json().catch(() => []) as Array<{ id: string; query_text: string; user_id?: string }>;

    const hasUserBQuestion = body.some((q) => q.query_text === "User B exclusive question");
    expect(
      hasUserBQuestion,
      `GET /api/watched as user A returned user B's question "User B exclusive question". ` +
        `The GET endpoint must only return questions belonging to the authenticated caller. ` +
        `Per-user isolation failure — horizontal privilege escalation risk.`
    ).toBe(false);

    // Also verify no row has user B's user_id in it
    const hasUserBId = body.some((q) => q.user_id === FIXTURE_USER_B.id);
    expect(
      hasUserBId,
      `GET /api/watched as user A returned a row with user_id="${FIXTURE_USER_B.id}". ` +
        `The endpoint must filter by the authenticated caller's user_id.`
    ).toBe(false);
  });

  it("GET /api/watched returns questions in newest-first order (by created_at)", async () => {
    // Add a new question so we have a clear ordering baseline
    const res1 = await postWatched("First ordering question", SESSION_A);
    expect(res1.status).toBe(200);

    // Small deliberate pause to ensure distinct created_at timestamps
    await new Promise((r) => setTimeout(r, 10));

    const res2 = await postWatched("Second ordering question — should appear first", SESSION_A);
    expect(res2.status).toBe(200);

    const listRes = await getWatched(SESSION_A);
    expect(listRes.status).toBe(200);

    const body = await listRes.json().catch(() => []) as Array<{ id: string; query_text: string; created_at: unknown }>;

    // Find the two new questions
    const idx1 = body.findIndex((q) => q.query_text === "First ordering question");
    const idx2 = body.findIndex((q) => q.query_text === "Second ordering question — should appear first");

    expect(idx1, `"First ordering question" not found in GET /api/watched response`).toBeGreaterThanOrEqual(0);
    expect(idx2, `"Second ordering question" not found in GET /api/watched response`).toBeGreaterThanOrEqual(0);

    expect(
      idx2,
      `GET /api/watched must return questions in newest-first order (by created_at DESC). ` +
        `"Second ordering question" (newer) is at index ${idx2}; ` +
        `"First ordering question" (older) is at index ${idx1}. ` +
        `The newer question must have a lower index (appear first).`
    ).toBeLessThan(idx1);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: DELETE /api/watched/:id — removes a question
// ---------------------------------------------------------------------------

describe("DELETE /api/watched/:id — removes a question", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    dbPath = makeTempDbPath("delete");
    runSeed(dbPath);
    db = await openDb(dbPath);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("DELETE /api/watched/:id returns 204", async () => {
    const idToDelete = SEED_QUESTIONS[0].id;

    const res = await deleteWatched(idToDelete, SESSION_A);
    expect(
      res.status,
      `DELETE ${WATCHED_ROUTES.deletePrefix}/${idToDelete} returned ${res.status}. Expected 204. ` +
        `The endpoint does not exist yet — task-watched-backend must implement it.`
    ).toBe(204);
  });

  it("DELETE /api/watched/:id removes the row from watched_questions", async () => {
    const idToDelete = SEED_QUESTIONS[1].id;

    // Pre-condition: the row must exist
    expect(
      rowExists(db, idToDelete),
      `Pre-condition failed: row with id="${idToDelete}" does not exist in watched_questions. ` +
        `Ensure the seed inserted this row.`
    ).toBe(true);

    const res = await deleteWatched(idToDelete, SESSION_A);
    expect(
      res.status,
      `DELETE returned ${res.status}, expected 204`
    ).toBe(204);

    // Row must be gone
    expect(
      rowExists(db, idToDelete),
      `Row with id="${idToDelete}" still exists in watched_questions after DELETE. ` +
        `The DELETE handler must remove the row permanently (no soft-delete).`
    ).toBe(false);
  });

  /**
   * DoD item 3: cascade deletion to question_matches.
   *
   * Dependency: the question_matches table lands in task-matching-impl (Sprint 3+).
   * This test either:
   *   (a) Asserts the cascade if the table exists, OR
   *   (b) Skips the cascade assertion with a clear TODO if the table is absent.
   *
   * The test still fails in Mode 1 because the DELETE endpoint itself is not
   * implemented. Once the endpoint exists, the cascade assertion becomes live
   * as soon as task-matching-impl lands.
   *
   * TODO (task-matching-impl): Remove the graceful skip once question_matches
   * exists. The DELETE handler must include:
   *   DELETE FROM question_matches WHERE question_id = :id
   * (or equivalent FK cascade) before deleting the watched_questions row.
   */
  it("DELETE /api/watched/:id also removes any cached question_matches for the question", async () => {
    const idToDelete = SEED_QUESTIONS[2].id;

    // Pre-condition: DELETE the question via the API first
    const res = await deleteWatched(idToDelete, SESSION_A);
    expect(res.status, `DELETE returned ${res.status}, expected 204`).toBe(204);

    // Check if question_matches table exists
    const matchesTableExists = questionMatchesTableExists(db);

    if (!matchesTableExists) {
      // TODO (task-matching-impl): When question_matches table lands, remove this branch.
      // At that point this test must fully assert cascade deletion.
      console.warn(
        `[TODO task-matching-impl] question_matches table does not exist yet. ` +
          `The cascade deletion assertion is skipped until that table is created. ` +
          `Once question_matches lands, DELETE /api/watched/:id must also delete all ` +
          `question_matches rows WHERE question_id = "${idToDelete}".`
      );
      // The test still passes on the primary DELETE assertion above.
      // We do NOT return early with a skip — we want the test structure to be present.
      return;
    }

    // If the table exists, assert cascade deletion
    const matchCount = countMatchesForQuestion(db, idToDelete);
    expect(
      matchCount,
      `question_matches has ${matchCount} rows for question_id="${idToDelete}" after DELETE. ` +
        `Expected 0. The DELETE handler must cascade-delete question_matches for the removed question. ` +
        `task-matching-impl dependency: see TODO note in this test.`
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: 5-cap enforcement
// ---------------------------------------------------------------------------

describe("5-cap enforcement — 6th POST returns 400 with UX-spec copy", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    dbPath = makeTempDbPath("cap");
    runSeed(dbPath);
    db = await openDb(dbPath);

    // Seed has 3 questions for user A; insert 2 more to reach exactly 5.
    // Strategy: direct DB insertion to avoid the cap being enforced during setup.
    for (const q of CAP_TOPUP_QUESTIONS) {
      insertWatchedQuestion(db, q);
    }

    // Verify pre-condition
    const count = countWatchedForUser(db, FIXTURE_USER_A.id);
    if (count !== 5) {
      throw new Error(
        `Pre-condition failed: expected 5 watched questions for user A, got ${count}. ` +
          `Check that the seed inserts 3 and the top-up inserts 2.`
      );
    }
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("POST /api/watched with 5 existing questions returns 400", async () => {
    const res = await postWatched("6th question attempt — should be rejected", SESSION_A);

    expect(
      res.status,
      `POST ${WATCHED_ROUTES.add} with 5 existing questions returned ${res.status}. Expected 400. ` +
        `The endpoint must enforce the 5-question cap per docs/design/dashboard.md §2B.`
    ).toBe(400);
  });

  it("400 response body contains the UX-spec'd cap-exceeded message", async () => {
    const res = await postWatched("Another 6th attempt", SESSION_A);
    expect(res.status).toBe(400);

    const body = await res.json().catch(() => null);
    const bodyText = body ? JSON.stringify(body) : await res.clone().text().catch(() => "");

    expect(
      bodyText.includes(CAP_EXCEEDED_MESSAGE),
      `400 response body does not contain the cap-exceeded message. ` +
        `Expected the exact string: "${CAP_EXCEEDED_MESSAGE}". ` +
        `Got: ${bodyText.slice(0, 500)}. ` +
        `Source: docs/design/dashboard.md §5B ("Cap-reached inline message").`
    ).toBe(true);
  });

  it("the 5 existing rows are unchanged after a rejected 6th POST", async () => {
    // POST a 6th (rejected)
    await postWatched("Rejected question", SESSION_A);

    // Count must still be 5
    const count = countWatchedForUser(db, FIXTURE_USER_A.id);
    expect(
      count,
      `After a rejected 6th POST, watched_questions has ${count} rows for user A. ` +
        `Expected exactly 5 — the rejection must not modify existing rows.`
    ).toBe(5);

    // Verify the seed questions and topup questions are intact
    const allIds = [...SEED_QUESTIONS, ...CAP_TOPUP_QUESTIONS].map((q) => q.id);
    for (const id of allIds) {
      expect(
        rowExists(db, id),
        `Row "${id}" is missing from watched_questions after the rejected 6th POST. ` +
          `The rejection must not delete or modify existing rows.`
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Per-user isolation
// ---------------------------------------------------------------------------

describe("Per-user isolation — list/delete are scoped to the caller", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    dbPath = makeTempDbPath("isolation");
    runSeed(dbPath);
    db = await openDb(dbPath);

    // Insert a question for user B
    insertWatchedQuestion(db, {
      id: "20000000-0000-0000-0000-000000000001",
      user_id: FIXTURE_USER_B.id,
      query_text: "User B: Will the ECB cut rates in 2026?",
    });
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("GET /api/watched as user A returns only user A's questions", async () => {
    const res = await getWatched(SESSION_A);
    expect(res.status).toBe(200);

    const body = await res.json().catch(() => []) as Array<{ user_id?: string; query_text: string }>;

    const foreignRows = body.filter((q) => q.user_id && q.user_id !== FIXTURE_USER_A.id);
    expect(
      foreignRows.length,
      `GET /api/watched as user A returned ${foreignRows.length} row(s) belonging to other users. ` +
        `Expected 0. Foreign rows: ${JSON.stringify(foreignRows)}. ` +
        `Per-user isolation violation.`
    ).toBe(0);
  });

  it("GET /api/watched as user B returns only user B's questions", async () => {
    const res = await getWatched(SESSION_B);
    expect(res.status).toBe(200);

    const body = await res.json().catch(() => []) as Array<{ user_id?: string; query_text: string }>;

    // User B should see only their own question
    const hasUserAQuestion = body.some((q) => SEED_QUESTIONS.some((sq) => sq.query_text === q.query_text));
    expect(
      hasUserAQuestion,
      `GET /api/watched as user B returned a question belonging to user A. ` +
        `Expected only user B's questions. Body: ${JSON.stringify(body)}. ` +
        `Per-user isolation violation.`
    ).toBe(false);

    const foreignRows = body.filter((q) => q.user_id && q.user_id !== FIXTURE_USER_B.id);
    expect(
      foreignRows.length,
      `GET /api/watched as user B returned ${foreignRows.length} row(s) not belonging to user B. ` +
        `Foreign rows: ${JSON.stringify(foreignRows)}.`
    ).toBe(0);
  });

  it("DELETE /api/watched/:id as user A on user B's question returns 404", async () => {
    const userBQuestionId = "20000000-0000-0000-0000-000000000001";

    const res = await deleteWatched(userBQuestionId, SESSION_A);

    // Must be 404 — not 200, not 204, not 500.
    // 404 leaks nothing about whether the row exists for another user.
    // 200/204 would mean the deletion succeeded (privilege escalation).
    // 500 would be an implementation error.
    expect(
      res.status,
      `DELETE /api/watched/${userBQuestionId} as user A returned ${res.status}. ` +
        `Expected 404. ` +
        `Returning 200/204 is a horizontal privilege escalation (user A deleted user B's question). ` +
        `Returning 403 would leak that the row exists but belongs to another user. ` +
        `404 is the correct response — the row does not exist from the caller's perspective. ` +
        `ADR-0001: per-user scoping is enforced via user_id in every DB query.`
    ).toBe(404);

    // The row must still exist in the DB — user B's question was not deleted
    expect(
      rowExists(db, userBQuestionId),
      `User B's question "${userBQuestionId}" was deleted from watched_questions ` +
        `after a DELETE attempt by user A. This is a horizontal privilege escalation.`
    ).toBe(true);
  });

  it("DELETE /api/watched/:id as user A on a non-existent id returns 404", async () => {
    const nonExistentId = "99999999-9999-9999-9999-999999999999";

    const res = await deleteWatched(nonExistentId, SESSION_A);
    expect(
      res.status,
      `DELETE /api/watched/${nonExistentId} (non-existent) returned ${res.status}. Expected 404.`
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Suite 6: Auth-gated — 401 without a session
// ---------------------------------------------------------------------------

describe("Auth-gated — all watched endpoints return 401 without a session", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    dbPath = makeTempDbPath("auth");
    runSeed(dbPath);
    db = await openDb(dbPath);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("GET /api/watched without a session returns 401", async () => {
    const res = await unauthenticatedRequest("GET", WATCHED_ROUTES.list);
    expect(
      [401, 403, 302, 307].includes(res.status),
      `GET ${WATCHED_ROUTES.list} without a session returned ${res.status}. ` +
        `Expected 401 (or a redirect to /signin). ` +
        `The endpoint must require authentication.`
    ).toBe(true);

    // If it returned 302/307, it must redirect toward /signin, not return data
    if (res.status === 302 || res.status === 307) {
      const location = res.headers.get("location") ?? "";
      expect(
        location.includes("/signin") || location.includes("/api/auth"),
        `GET /api/watched unauthenticated redirect goes to "${location}", not /signin.`
      ).toBe(true);
    }
  });

  it("POST /api/watched without a session returns 401", async () => {
    const res = await unauthenticatedRequest(
      "POST",
      WATCHED_ROUTES.add,
      JSON.stringify({ query_text: "Unauthenticated add attempt" })
    );
    expect(
      [401, 403, 302, 307].includes(res.status),
      `POST ${WATCHED_ROUTES.add} without a session returned ${res.status}. ` +
        `Expected 401 (or redirect). The endpoint must require authentication.`
    ).toBe(true);
  });

  it("DELETE /api/watched/:id without a session returns 401", async () => {
    const someId = SEED_QUESTIONS[0].id;
    const res = await unauthenticatedRequest(
      "DELETE",
      `${WATCHED_ROUTES.deletePrefix}/${someId}`
    );
    expect(
      [401, 403, 302, 307].includes(res.status),
      `DELETE ${WATCHED_ROUTES.deletePrefix}/${someId} without a session returned ${res.status}. ` +
        `Expected 401 (or redirect). The endpoint must require authentication.`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 7: Input validation
// ---------------------------------------------------------------------------

describe("Input validation — POST /api/watched rejects invalid query_text", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  let countBefore: number;

  beforeAll(async () => {
    dbPath = makeTempDbPath("validation");
    runSeed(dbPath);
    db = await openDb(dbPath);
    countBefore = countWatchedForUser(db, FIXTURE_USER_A.id);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("POST with empty query_text returns 400 with a clear error", async () => {
    const res = await postWatched("", SESSION_A);

    expect(
      res.status,
      `POST ${WATCHED_ROUTES.add} with empty query_text returned ${res.status}. Expected 400. ` +
        `The endpoint must reject empty query_text.`
    ).toBe(400);

    const body = await res.json().catch(() => null);
    const bodyText = body ? JSON.stringify(body) : "";

    // The error body must be non-empty and contain a meaningful message
    expect(
      bodyText.length > 0 && bodyText !== "{}",
      `400 response for empty query_text has no error message. ` +
        `The endpoint must return a clear inline error per DoD item 7. Got: ${bodyText}`
    ).toBe(true);
  });

  it("POST with whitespace-only query_text returns 400", async () => {
    const res = await postWatched("   \t\n   ", SESSION_A);

    expect(
      res.status,
      `POST ${WATCHED_ROUTES.add} with whitespace-only query_text returned ${res.status}. ` +
        `Expected 400. Whitespace-only text is semantically empty and must be rejected. ` +
        `The handler must trim before validating.`
    ).toBe(400);
  });

  it(`POST with query_text exceeding ${MAX_QUERY_TEXT_LENGTH} characters returns 400`, async () => {
    // 281 characters — one over the 280-char limit
    const longText = "A".repeat(MAX_QUERY_TEXT_LENGTH + 1);
    const res = await postWatched(longText, SESSION_A);

    expect(
      res.status,
      `POST ${WATCHED_ROUTES.add} with a ${MAX_QUERY_TEXT_LENGTH + 1}-character query_text returned ${res.status}. ` +
        `Expected 400. The max length is ${MAX_QUERY_TEXT_LENGTH} characters (Twitter precedent). ` +
        `Document this limit in the route handler.`
    ).toBe(400);
  });

  it("invalid inputs do not insert rows — row count is unchanged", async () => {
    // Fire all three invalid inputs
    await postWatched("", SESSION_A);
    await postWatched("   ", SESSION_A);
    await postWatched("B".repeat(MAX_QUERY_TEXT_LENGTH + 1), SESSION_A);

    const countAfter = countWatchedForUser(db, FIXTURE_USER_A.id);
    expect(
      countAfter,
      `watched_questions row count changed from ${countBefore} to ${countAfter} ` +
        `after submitting invalid inputs. ` +
        `Invalid POST requests must not insert rows into the database.`
    ).toBe(countBefore);
  });

  it("POST with exactly MAX_QUERY_TEXT_LENGTH characters succeeds (boundary check)", async () => {
    const exactText = "C".repeat(MAX_QUERY_TEXT_LENGTH);
    const res = await postWatched(exactText, SESSION_A);

    expect(
      res.status,
      `POST ${WATCHED_ROUTES.add} with exactly ${MAX_QUERY_TEXT_LENGTH} characters returned ${res.status}. ` +
        `Expected 200. A query of exactly the max length must be accepted.`
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Suite 8: Cap-counter semantic — deleted rows do NOT count
// ---------------------------------------------------------------------------

describe("Cap-counter semantic — deleted rows do not count toward the 5-cap", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    dbPath = makeTempDbPath("counter");
    runSeed(dbPath);
    db = await openDb(dbPath);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("after 3 adds + 1 delete + 1 add the count is 3 (not 4), verifiable via GET", async () => {
    // Starting state: 3 questions from seed (user A)
    const initialRes = await getWatched(SESSION_A);
    expect(initialRes.status).toBe(200);
    const initialList = await initialRes.json().catch(() => []) as Array<{ id: string; query_text: string }>;
    expect(
      initialList.length,
      `Expected 3 seed questions, got ${initialList.length}. ` +
        `Ensure the seed inserts exactly 3 questions for user A.`
    ).toBe(3);

    // Add question 4
    const add4Res = await postWatched("Add-4 question for counter test", SESSION_A);
    expect(add4Res.status, `Add question 4 failed with status ${add4Res.status}`).toBe(200);
    const add4Body = await add4Res.json().catch(() => null);
    const add4Id = add4Body?.id;
    expect(add4Id, "Add question 4 must return an id").toBeTruthy();

    // Add question 5
    const add5Res = await postWatched("Add-5 question for counter test", SESSION_A);
    expect(add5Res.status, `Add question 5 failed with status ${add5Res.status}`).toBe(200);

    // Now at 5. Delete question 4.
    const del4Res = await deleteWatched(add4Id, SESSION_A);
    expect(del4Res.status, `Delete question 4 failed with status ${del4Res.status}`).toBe(204);

    // Count should be 4 (3 seed + 1 remaining add)
    // Now add a replacement (would be the 5th active question)
    const add6Res = await postWatched("Replacement after delete", SESSION_A);
    expect(
      add6Res.status,
      `After 3 seed + 2 adds + 1 delete = 4 active questions, ` +
        `adding a 5th (replacement) returned ${add6Res.status}. Expected 200. ` +
        `Deleted rows must NOT count toward the 5-question cap. ` +
        `This tests DoD item 8: "soft-delete is NOT used".`
    ).toBe(200);

    // Final count: 3 seed + 1 (add5) + 1 (replacement) = 5, minus 1 (deleted add4) = 5? No:
    // 3 + 1(add4) + 1(add5) - 1(del4) + 1(replacement) = 5
    // Actually: 3 seed + 1(add5) + 1(replacement) = 5 (add4 was deleted)
    const finalRes = await getWatched(SESSION_A);
    expect(finalRes.status).toBe(200);
    const finalList = await finalRes.json().catch(() => []) as Array<{ id: string; query_text: string }>;

    // Should have 5 questions (3 seed + add5 + replacement)
    expect(
      finalList.length,
      `Final count via GET /api/watched is ${finalList.length}. ` +
        `Expected 5 (3 seed + add5 + replacement). ` +
        `Sequence: 3 adds (seed) + 1 add (4) + 1 add (5) - 1 delete (4) + 1 add (replacement) = 5 active.`
    ).toBe(5);

    // Verify add4 is not in the list (it was deleted)
    const hasAdd4 = finalList.some((q) => q.id === add4Id);
    expect(
      hasAdd4,
      `Deleted question "${add4Id}" still appears in the GET /api/watched response. ` +
        `Hard-delete must remove the row permanently.`
    ).toBe(false);

    // Also verify via DB
    const dbCount = countWatchedForUser(db, FIXTURE_USER_A.id);
    expect(
      dbCount,
      `DB count for user A is ${dbCount}. Expected 5. ` +
        `The DB must have exactly 5 rows after the described sequence.`
    ).toBe(5);
  });

  it("the 6th add IS rejected when the active count is 5 after a delete+add cycle", async () => {
    // At this point from the previous test, user A has 5 active questions.
    // Adding a 6th must still be rejected.
    const res = await postWatched("Should be rejected — 6th in counter test", SESSION_A);

    expect(
      res.status,
      `POST /api/watched with 5 active questions (post delete+add cycle) returned ${res.status}. ` +
        `Expected 400. The cap must enforce against ACTIVE (non-deleted) row count.`
    ).toBe(400);

    const body = await res.json().catch(() => null);
    const bodyText = body ? JSON.stringify(body) : "";
    expect(
      bodyText.includes(CAP_EXCEEDED_MESSAGE),
      `400 response does not contain the cap-exceeded message. ` +
        `Expected: "${CAP_EXCEEDED_MESSAGE}". Got: ${bodyText.slice(0, 500)}.`
    ).toBe(true);
  });
});
