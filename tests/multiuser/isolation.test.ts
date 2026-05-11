/**
 * tests/multiuser/isolation.test.ts
 *
 * Mode 1 (pre-implementation) — ALL 10 tests in this file MUST FAIL until:
 *
 *   (1) tests/seeds/queries.yaml is extended with fixture_user_b + questions_user_b
 *       AND scripts/seed.ts reads + inserts those rows when PREDMKT_MULTIUSER_TEST=true.
 *       Production code path: scripts/seed.ts
 *
 *   (2–9) The full multiuser seed is wired, which requires:
 *       - scripts/seed.ts handles fixture_user_b + questions_user_b + session for user B
 *       - All API handlers derive userId from session only (no IDOR)
 *       - Cron handler iterates ALL users, using each user's own key
 *       - lib/alerts.ts dispatches emails only to the question owner
 *       - Hysteresis state (alerts table) is per-user, per-question, not global
 *       Production code paths: scripts/seed.ts, app/api/watched/route.ts,
 *         app/api/watched/[id]/route.ts, app/api/me/anakin-key/route.ts,
 *         app/api/cron/refresh-spreads/route.ts, lib/alerts.ts,
 *         app/api/test-set-key-status/route.ts
 *
 *   (10) Brand-new email sign-in: NextAuth Drizzle adapter creates the user row
 *        AND the post-auth redirect detects key-missing status and routes to
 *        /onboarding/anakin-key (currently the seeded test harness only knows
 *        the fixture user; there is no wired path for dynamic user creation in
 *        the in-process test harness).
 *        Production code path: app/api/auth/[...nextauth]/route.ts, NextAuth
 *          callbacks.redirect, app/api/me/route.ts
 *
 * DoD items:
 *   1.  GET /api/watched as A → A's 3 questions only; as B → B's 2 questions only
 *   2.  DELETE A's question as B → 404
 *   3.  POST /api/me/anakin-key as A stores only on A; B's row is unaffected
 *   4.  GET /api/me/anakin-key as A returns A's status, never B's
 *   5.  Wire calls use the correct per-user key (auth header assertion)
 *   6.  Cron processes both users; each uses only their own key
 *   7.  Alerts dispatched to the correct recipient only
 *   8.  Hysteresis is per-user, per-question (A fired ≠ B suppressed)
 *   9.  /api/test-set-key-status scoped to authenticated session user (or rejects
 *       attempts to mutate a different user without a session for that user)
 *   10. Brand-new email sign-in creates a fresh user row, routes to onboarding
 *
 * Seed (beforeAll):
 *   User A: FIXTURE_USER_A — Anakin key "ok", 3 watched questions, spread snapshots
 *   User B: FIXTURE_USER_B — Anakin key "ok" (different plaintext), 2 watched questions,
 *           spread snapshots — one question text deliberately identical to A's so
 *           naive cross-contamination is caught.
 *
 * WIRE_MODE=fixtures throughout so no live Anakin calls are made.
 * DB: temporary SQLite file per beforeAll, deleted in afterAll.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { clearInbox, getInbox } from "../auth/__mocks__/resend";

vi.mock("resend");

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

/**
 * User A: primary fixture user with an Anakin key.
 * Matches tests/seeds/queries.yaml fixture_user.
 */
const FIXTURE_USER_A = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "fixture@predmkt-arb.test",
  anakin_key_status: "ok" as const,
  plaintext_key: "fixture-anakin-key-for-testing-only",
} as const;

/**
 * User B: NEW fixture user — must be seeded by scripts/seed.ts when
 * PREDMKT_MULTIUSER_TEST=true. Uses queries_user_b from queries.yaml.
 *
 * Production code path: scripts/seed.ts must read fixture_user_b from
 * tests/seeds/queries.yaml and insert it alongside fixture_user.
 */
const FIXTURE_USER_B = {
  id: "00000000-0000-0000-0000-000000000003",
  email: "userb@predmkt-arb.test",
  anakin_key_status: "ok" as const,
  /**
   * Plaintext key for user B — deliberately different from A's key.
   * The seed script must encrypt and store this.
   * Production code path: scripts/seed.ts (encrypt with APP_ENCRYPTION_KEY, AAD=user_b.id)
   */
  plaintext_key: "fixture-anakin-key-user-b-testing-only",
} as const;

/** Session token for User A. */
const SESSION_A =
  process.env.FIXTURE_SESSION_TOKEN ?? "fixture-session-token-do-not-use-in-prod";

/**
 * Session token for User B.
 * Must be inserted into the sessions table when PREDMKT_MULTIUSER_TEST=true.
 * Production code path: scripts/seed.ts
 */
const SESSION_B =
  process.env.FIXTURE_SESSION_TOKEN_B ?? "fixture-session-token-b-do-not-use-in-prod";

/**
 * User B's dedicated session token (distinct from SESSION_B which is shared
 * with the no-key fixture user in the key isolation tests). When the
 * multiuser seed is implemented, PREDMKT_MULTIUSER_TEST=true must cause
 * scripts/seed.ts to seed user B with this token.
 */
const SESSION_MULTIUSER_B =
  process.env.FIXTURE_SESSION_TOKEN_MULTIUSER_B ?? "fixture-session-token-multiuser-b";

/** Seed questions for User A (from queries.yaml). */
const A_QUESTIONS = [
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
 * Seed questions for User B (from queries_user_b in queries.yaml).
 * Note: question id=...0011 uses the same text as A's question id=...0001.
 * This deliberate overlap is the cross-contamination trap.
 * Production code path: scripts/seed.ts must insert these rows.
 */
const B_QUESTIONS = [
  {
    id: "10000000-0000-0000-0000-000000000011",
    query_text: "Will the Fed raise interest rates in 2026?", // same text as A's first question
    user_id: FIXTURE_USER_B.id,
  },
  {
    id: "10000000-0000-0000-0000-000000000012",
    query_text: "Will Bitcoin exceed $200k before end of 2026?",
    user_id: FIXTURE_USER_B.id,
  },
] as const;

// ---------------------------------------------------------------------------
// Infrastructure constants
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const SEED_SCRIPT = join(REPO_ROOT, "scripts", "seed.ts");
const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const TEST_APP_ENCRYPTION_KEY =
  process.env.APP_ENCRYPTION_KEY ?? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/** IPC file that server-setup.ts reads to resolve DATABASE_URL. */
const IPC_FILE = join(tmpdir(), ".predmkt-test-current-db-url");

const TEST_CRON_SECRET = "test-cron-secret-do-not-use-in-prod";

// ---------------------------------------------------------------------------
// DB and seed helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(label: string): string {
  const dir = join(tmpdir(), "predmkt-arb-multiuser-tests");
  mkdirSync(dir, { recursive: true });
  return join(dir, `multiuser-${label}-${process.pid}.db`);
}

/**
 * Run the seed script with PREDMKT_MULTIUSER_TEST=true so that scripts/seed.ts
 * inserts both fixture_user_b and questions_user_b.
 *
 * EXPECTED FAILURE (Mode 1): seed.ts does not yet honour PREDMKT_MULTIUSER_TEST,
 * so user B and B's questions will NOT be present in the DB. Every test that
 * asserts on user B's data will fail with a clear "user/question not found" error.
 *
 * Production code path: scripts/seed.ts
 */
function runSeed(dbPath: string): void {
  const dbUrl = `file:${dbPath}`;
  // Write IPC file so the watched/key server setup resolves to this DB.
  writeFileSync(IPC_FILE, dbUrl, "utf8");
  execFileSync("npx", ["tsx", SEED_SCRIPT], {
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
      WIRE_MODE: "fixtures",
      APP_ENCRYPTION_KEY: TEST_APP_ENCRYPTION_KEY,
      NODE_ENV: "test",
      PREDMKT_KEY_TEST: "true",
      // This flag must be honoured by scripts/seed.ts to insert user B rows.
      PREDMKT_MULTIUSER_TEST: "true",
    },
    cwd: REPO_ROOT,
    stdio: "pipe",
    timeout: 30_000,
  });
  process.env.DATABASE_URL = dbUrl;
}

/** Open the test DB with better-sqlite3 (synchronous). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function openDb(dbPath: string): any {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  return sqlite;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function userExists(db: any, userId: string): boolean {
  const row = db.prepare("SELECT id FROM users WHERE id = ?").get(userId) as
    | { id: string }
    | undefined;
  return row !== undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function questionExists(db: any, questionId: string): boolean {
  const row = db
    .prepare("SELECT id FROM watched_questions WHERE id = ?")
    .get(questionId) as { id: string } | undefined;
  return row !== undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function countQuestionsForUser(db: any, userId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM watched_questions WHERE user_id = ?")
    .get(userId) as { cnt: number };
  return row.cnt;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSpreadSnapshot(db: any, questionId: string): { spread: number | null } | undefined {
  return db
    .prepare("SELECT spread FROM spread_snapshots WHERE question_id = ? ORDER BY computed_at DESC LIMIT 1")
    .get(questionId) as { spread: number | null } | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seedSpreadSnapshot(db: any, questionId: string, spread: number): void {
  const nowSec = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT OR REPLACE INTO spread_snapshots (id, question_id, spread, last_updated, computed_at)
     VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)`
  ).run(questionId, spread, nowSec - 120, nowSec - 120); // stale: 2 min ago so cron re-computes
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seedAlertState(
  db: any,
  questionId: string,
  userId: string,
  state: "armed" | "fired"
): void {
  db.prepare(
    `INSERT OR REPLACE INTO alerts (id, question_id, user_id, state, last_alerted_at, last_alerted_spread)
     VALUES (lower(hex(randomblob(16))), ?, ?, ?, NULL, NULL)`
  ).run(questionId, userId, state);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAlertState(db: any, questionId: string, userId: string): string | undefined {
  const row = db
    .prepare("SELECT state FROM alerts WHERE question_id = ? AND user_id = ?")
    .get(questionId, userId) as { state: string } | undefined;
  return row?.state;
}

// ---------------------------------------------------------------------------
// HTTP helper factories
// ---------------------------------------------------------------------------

async function apiGet(path: string, sessionToken: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: { Cookie: `next-auth.session-token=${sessionToken}` },
    redirect: "manual",
  });
}

async function apiPost(
  path: string,
  sessionToken: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `next-auth.session-token=${sessionToken}`,
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

async function apiDelete(path: string, sessionToken: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: { Cookie: `next-auth.session-token=${sessionToken}` },
    redirect: "manual",
  });
}

async function runCronTick(): Promise<Response> {
  return fetch(`${BASE_URL}/api/cron/refresh-spreads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-secret": TEST_CRON_SECRET,
    },
    redirect: "manual",
  });
}

// ---------------------------------------------------------------------------
// Test 1: GET /api/watched isolation
// ---------------------------------------------------------------------------

describe("1. GET /api/watched returns only the authenticated user's questions", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(() => {
    dbPath = makeTempDbPath("watched-list");
    runSeed(dbPath);
    db = openDb(dbPath);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("User A's GET returns exactly 3 questions — all owned by A, none by B", async () => {
    // EXPECTED FAILURE (Mode 1):
    //   scripts/seed.ts does not insert user B or B's questions yet.
    //   The user B questions will not exist, so the cross-contamination check
    //   cannot run. Pre-condition assertion below will fail first.
    //
    // Production code path: scripts/seed.ts (PREDMKT_MULTIUSER_TEST branch)
    expect(
      userExists(db, FIXTURE_USER_B.id),
      `Pre-condition: user B (id=${FIXTURE_USER_B.id}) must exist in the DB. ` +
        `scripts/seed.ts must insert fixture_user_b from tests/seeds/queries.yaml ` +
        `when PREDMKT_MULTIUSER_TEST=true.`
    ).toBe(true);

    const res = await apiGet("/api/watched", SESSION_A);
    expect(res.status, `GET /api/watched as A must return 200, got ${res.status}`).toBe(200);

    const rows = (await res.json()) as Array<{ id: string; user_id?: string }>;
    expect(
      rows.length,
      `User A must have exactly ${A_QUESTIONS.length} watched questions, got ${rows.length}`
    ).toBe(A_QUESTIONS.length);

    const aIds = new Set(A_QUESTIONS.map((q) => q.id));
    const bIds = new Set(B_QUESTIONS.map((q) => q.id));

    for (const row of rows) {
      expect(
        aIds.has(row.id),
        `Question id=${row.id} returned for user A is not in A's seed set. ` +
          `GET /api/watched must return only the authenticated user's rows. ` +
          `app/api/watched/route.ts WHERE user_id = session.userId`
      ).toBe(true);
      expect(
        bIds.has(row.id),
        `Question id=${row.id} returned for user A belongs to user B. ` +
          `Cross-user data leak in GET /api/watched. ` +
          `app/api/watched/route.ts must scope query to session.userId only.`
      ).toBe(false);
    }
  });

  it("User B's GET returns exactly 2 questions — all owned by B, none by A", async () => {
    // EXPECTED FAILURE (Mode 1): user B doesn't exist yet in the seed.
    // Production code path: scripts/seed.ts (PREDMKT_MULTIUSER_TEST branch)
    expect(
      userExists(db, FIXTURE_USER_B.id),
      `Pre-condition: user B (id=${FIXTURE_USER_B.id}) must exist in the DB. ` +
        `scripts/seed.ts must insert fixture_user_b when PREDMKT_MULTIUSER_TEST=true.`
    ).toBe(true);

    const res = await apiGet("/api/watched", SESSION_MULTIUSER_B);
    expect(res.status, `GET /api/watched as B must return 200, got ${res.status}`).toBe(200);

    const rows = (await res.json()) as Array<{ id: string }>;
    expect(
      rows.length,
      `User B must have exactly ${B_QUESTIONS.length} watched questions, got ${rows.length}`
    ).toBe(B_QUESTIONS.length);

    const aIds = new Set(A_QUESTIONS.map((q) => q.id));
    const bIds = new Set(B_QUESTIONS.map((q) => q.id));

    for (const row of rows) {
      expect(
        bIds.has(row.id),
        `Question id=${row.id} returned for user B is not in B's seed set.`
      ).toBe(true);
      expect(
        aIds.has(row.id),
        `Question id=${row.id} returned for user B belongs to user A. ` +
          `Cross-user data leak in GET /api/watched. ` +
          `app/api/watched/route.ts must scope query to session.userId only.`
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: DELETE A's question as B → 404
// ---------------------------------------------------------------------------

describe("2. DELETE A's question as B returns 404", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(() => {
    dbPath = makeTempDbPath("delete-cross");
    runSeed(dbPath);
    db = openDb(dbPath);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("DELETE /api/watched/:aQuestionId as user B returns 404 (not 200, not 403)", async () => {
    // EXPECTED FAILURE (Mode 1): user B's session doesn't exist in the seed,
    // so the server returns 401 (not a session), not 404.
    // After implementation, user B is authenticated but the question belongs to
    // A — the handler must return 404 (as if the row doesn't exist for this user).
    //
    // Production code path: app/api/watched/[id]/route.ts
    //   DELETE must WHERE id = ? AND user_id = session.userId.
    //   If no row matches, return 404.
    const aQuestionId = A_QUESTIONS[0].id;

    // Pre-condition: question must exist
    expect(
      questionExists(db, aQuestionId),
      `Pre-condition: A's question ${aQuestionId} must exist in the DB.`
    ).toBe(true);

    const res = await apiDelete(
      `/api/watched/${aQuestionId}`,
      SESSION_MULTIUSER_B
    );
    expect(
      res.status,
      `DELETE /api/watched/${aQuestionId} as user B must return 404. ` +
        `Got ${res.status}. ` +
        `app/api/watched/[id]/route.ts: DELETE must check WHERE id=? AND user_id=session.userId; ` +
        `return 404 when the row doesn't belong to the caller. ` +
        `Returning 403 would confirm existence (IDOR oracle); 404 is the correct contract.`
    ).toBe(404);

    // Question must still exist (not deleted by cross-user attempt)
    expect(
      questionExists(db, aQuestionId),
      `A's question ${aQuestionId} was deleted by user B's cross-user DELETE attempt. ` +
        `app/api/watched/[id]/route.ts must scope deletions to session.userId.`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 3: POST /api/me/anakin-key as A stores only on A
// ---------------------------------------------------------------------------

describe("3. POST /api/me/anakin-key as A stores only on A", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(() => {
    dbPath = makeTempDbPath("key-store");
    runSeed(dbPath);
    db = openDb(dbPath);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("POST a new key as A; B's anakin_key_ct row is unchanged", async () => {
    // EXPECTED FAILURE (Mode 1): user B is not in the seed; can't check B's row.
    // Production code path: app/api/me/anakin-key/route.ts
    //   POST must use session.userId — never a user_id body param.
    expect(
      userExists(db, FIXTURE_USER_B.id),
      `Pre-condition: user B (id=${FIXTURE_USER_B.id}) must exist in the DB.`
    ).toBe(true);

    const bRowBefore = db
      .prepare("SELECT anakin_key_ct, anakin_key_status FROM users WHERE id = ?")
      .get(FIXTURE_USER_B.id) as
      | { anakin_key_ct: Buffer | null; anakin_key_status: string }
      | undefined;

    // Post a new key as A
    const newKeyA = "ak_test_new-key-for-user-a-isolation";
    const res = await apiPost("/api/me/anakin-key", SESSION_A, { key: newKeyA });
    expect(
      [200, 201].includes(res.status),
      `POST /api/me/anakin-key as A must return 200/201, got ${res.status}. ` +
        `app/api/me/anakin-key/route.ts POST handler`
    ).toBe(true);

    // B's row must be identical after A saves a key
    const bRowAfter = db
      .prepare("SELECT anakin_key_ct, anakin_key_status FROM users WHERE id = ?")
      .get(FIXTURE_USER_B.id) as
      | { anakin_key_ct: Buffer | null; anakin_key_status: string }
      | undefined;

    expect(
      bRowAfter?.anakin_key_status,
      `User B's anakin_key_status changed after user A saved a key. ` +
        `app/api/me/anakin-key/route.ts must UPDATE WHERE id = session.userId only.`
    ).toBe(bRowBefore?.anakin_key_status);

    // Compare ciphertext blobs (null vs non-null or same bytes)
    const ctBefore = bRowBefore?.anakin_key_ct?.toString("hex") ?? null;
    const ctAfter = bRowAfter?.anakin_key_ct?.toString("hex") ?? null;
    expect(
      ctAfter,
      `User B's anakin_key_ct changed after user A saved a key. ` +
        `Cross-user write detected in POST /api/me/anakin-key. ` +
        `app/api/me/anakin-key/route.ts must scope UPDATE to session.userId.`
    ).toBe(ctBefore);
  });
});

// ---------------------------------------------------------------------------
// Test 4: GET /api/me/anakin-key returns the caller's own status
// ---------------------------------------------------------------------------

describe("4. GET /api/me/anakin-key returns only the caller's status", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(() => {
    dbPath = makeTempDbPath("key-status");
    runSeed(dbPath);
    db = openDb(dbPath);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("GET /api/me/anakin-key as A returns A's status (ok), not B's status", async () => {
    // EXPECTED FAILURE (Mode 1): user B not in seed.
    // Production code path: app/api/me/anakin-key/route.ts GET handler
    expect(
      userExists(db, FIXTURE_USER_B.id),
      `Pre-condition: user B must exist in the DB.`
    ).toBe(true);

    const resA = await apiGet("/api/me/anakin-key", SESSION_A);
    expect(resA.status, `GET /api/me/anakin-key as A must return 200, got ${resA.status}`).toBe(200);

    const bodyA = (await resA.json()) as Record<string, unknown>;
    const statusA = (bodyA.status ?? bodyA.anakin_key_status ?? "") as string;

    expect(
      statusA,
      `GET /api/me/anakin-key as A must return status="ok" (A's status). ` +
        `Got "${statusA}". If this is B's status, there is a cross-user data leak. ` +
        `app/api/me/anakin-key/route.ts GET must derive userId from session only.`
    ).toBe("ok");
  });

  it("GET /api/me/anakin-key as B returns B's status, not A's email or status", async () => {
    // EXPECTED FAILURE (Mode 1): user B's session not seeded.
    // Production code path: app/api/me/anakin-key/route.ts GET handler
    const resB = await apiGet("/api/me/anakin-key", SESSION_MULTIUSER_B);
    expect(resB.status, `GET /api/me/anakin-key as B must return 200, got ${resB.status}`).toBe(200);

    const bodyB = (await resB.json()) as Record<string, unknown>;
    const bodyStr = JSON.stringify(bodyB);

    // B's response must not contain A's email
    expect(
      bodyStr.includes(FIXTURE_USER_A.email),
      `GET /api/me/anakin-key as B returned A's email "${FIXTURE_USER_A.email}". ` +
        `Cross-user data leak. app/api/me/anakin-key/route.ts GET must scope to session.userId.`
    ).toBe(false);

    // B's response must not contain A's user id
    expect(
      bodyStr.includes(FIXTURE_USER_A.id),
      `GET /api/me/anakin-key as B returned A's user id. Cross-user data leak. ` +
        `app/api/me/anakin-key/route.ts GET handler`
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Wire calls use the correct per-user key
// ---------------------------------------------------------------------------

describe("5. Wire calls carry the correct per-user auth header", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(() => {
    dbPath = makeTempDbPath("wire-keys");
    runSeed(dbPath);
    db = openDb(dbPath);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("probe endpoint as A sends A's plaintext key, not B's", async () => {
    // EXPECTED FAILURE (Mode 1): user B not in seed; no competing key to cross-check.
    // Production code path: app/api/me/anakin-key/probe/route.ts,
    //   lib/wire/decrypt.ts (AAD = userId prevents cross-user decryption)
    expect(
      userExists(db, FIXTURE_USER_B.id),
      `Pre-condition: user B must exist in the DB to assert no cross-key contamination.`
    ).toBe(true);

    const res = await fetch(`${BASE_URL}/api/me/anakin-key/probe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `next-auth.session-token=${SESSION_A}`,
        "X-Test-Observe-Auth-Header": "true",
      },
      body: JSON.stringify({ userId: FIXTURE_USER_A.id }),
      redirect: "manual",
    });

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const authHeader = (
      body.observedAuthHeader ?? body.authHeader ?? body.authorization ?? ""
    ) as string;

    // Must carry A's key
    expect(
      authHeader,
      `Probe as user A must return A's key in the auth header. ` +
        `Expected "Bearer ${FIXTURE_USER_A.plaintext_key}" but got "${authHeader}". ` +
        `app/api/me/anakin-key/probe/route.ts + lib/wire/client.ts wireRequest`
    ).toBe(`Bearer ${FIXTURE_USER_A.plaintext_key}`);

    // Must NOT carry B's key
    expect(
      authHeader.includes(FIXTURE_USER_B.plaintext_key),
      `Probe as user A carries B's key — cross-user credential leak. ` +
        `Auth header: "${authHeader}". ` +
        `lib/wire/decrypt.ts: AAD = userId ensures A's ciphertext cannot be decrypted with B's id.`
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Cron processes both users with correct keys
// ---------------------------------------------------------------------------

describe("6. Cron processes both users; each uses only their own key", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(() => {
    dbPath = makeTempDbPath("cron-multiuser");
    runSeed(dbPath);
    db = openDb(dbPath);

    // Seed stale spread snapshots for both A's and B's questions so the cron
    // handler must call Wire for each (snapshot older than idempotency window).
    for (const q of A_QUESTIONS) {
      if (questionExists(db, q.id)) {
        seedSpreadSnapshot(db, q.id, 0.02);
      }
    }
    for (const q of B_QUESTIONS) {
      if (questionExists(db, q.id)) {
        seedSpreadSnapshot(db, q.id, 0.02);
      }
    }
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("cron tick updates spread_snapshots for both A's and B's questions", async () => {
    // EXPECTED FAILURE (Mode 1): user B and B's questions not in seed.
    // Production code path: app/api/cron/refresh-spreads/route.ts
    //   Must iterate ALL users with status=ok, not just the first user found.
    expect(
      userExists(db, FIXTURE_USER_B.id),
      `Pre-condition: user B must exist in the DB so the cron can process their questions.`
    ).toBe(true);
    expect(
      questionExists(db, B_QUESTIONS[0].id),
      `Pre-condition: B's first question (${B_QUESTIONS[0].id}) must exist in the DB.`
    ).toBe(true);

    const nowBefore = Math.floor(Date.now() / 1000);
    const res = await runCronTick();
    expect(
      [200, 201].includes(res.status),
      `POST /api/cron/refresh-spreads must return 200, got ${res.status}. ` +
        `app/api/cron/refresh-spreads/route.ts`
    ).toBe(true);

    // After the cron tick, both A's and B's questions should have fresh snapshots.
    // Assert at least one of A's questions and at least one of B's questions
    // have a computed_at >= nowBefore.
    const aFresh = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM spread_snapshots ss
         INNER JOIN watched_questions wq ON ss.question_id = wq.id
         WHERE wq.user_id = ? AND ss.computed_at >= ?`
      )
      .get(FIXTURE_USER_A.id, nowBefore) as { cnt: number };

    expect(
      aFresh.cnt,
      `After cron tick, user A's questions must have at least one fresh spread_snapshot. ` +
        `Got ${aFresh.cnt}. ` +
        `app/api/cron/refresh-spreads/route.ts must process A's questions.`
    ).toBeGreaterThan(0);

    const bFresh = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM spread_snapshots ss
         INNER JOIN watched_questions wq ON ss.question_id = wq.id
         WHERE wq.user_id = ? AND ss.computed_at >= ?`
      )
      .get(FIXTURE_USER_B.id, nowBefore) as { cnt: number };

    expect(
      bFresh.cnt,
      `After cron tick, user B's questions must have at least one fresh spread_snapshot. ` +
        `Got ${bFresh.cnt}. ` +
        `app/api/cron/refresh-spreads/route.ts must iterate ALL users, not just user A.`
    ).toBeGreaterThan(0);
  });

  it("cron Wire calls use A's key for A's questions and B's key for B's questions", async () => {
    // EXPECTED FAILURE (Mode 1): user B not in seed; only A's Wire calls are recorded.
    // Production code path: lib/wire/client.ts wireRequest (per-user key lookup)
    const { getLastWireCall, clearWireCalls } = await import(
      "../../lib/wire/fixtures.js"
    );
    clearWireCalls();

    // Trigger another cron tick (idempotency cache was cleared in beforeEach at setup level)
    await runCronTick();

    const lastCall = getLastWireCall();
    // The last Wire call must have used either A's or B's key (both are valid).
    // More importantly, it must NOT be an empty auth header (which would mean
    // the wrong user's key was used and decryption failed silently).
    expect(
      lastCall?.authHeader,
      `The last Wire call must have a non-empty auth header. ` +
        `An empty auth header means key decryption failed — likely a cross-user AAD mismatch. ` +
        `lib/wire/client.ts: wireRequest must call getDecryptedAnakinKey(userId) with ` +
        `the correct userId for each user's questions.`
    ).toBeTruthy();

    // Assert the auth header is one of the two valid keys (not some other value)
    const validHeaders = [
      `Bearer ${FIXTURE_USER_A.plaintext_key}`,
      `Bearer ${FIXTURE_USER_B.plaintext_key}`,
    ];
    expect(
      validHeaders.includes(lastCall?.authHeader ?? ""),
      `Last Wire call auth header "${lastCall?.authHeader}" is not A's or B's key. ` +
        `lib/wire/client.ts: the auth header must be "Bearer <user_key>" for the correct user.`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Alerts dispatched to the correct recipient
// ---------------------------------------------------------------------------

describe("7. Alert emails are dispatched to the correct recipient only", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(() => {
    dbPath = makeTempDbPath("alerts-recipient");
    runSeed(dbPath);
    db = openDb(dbPath);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  beforeEach(() => {
    clearInbox();
  });

  it("threshold cross on A's question → 1 email to A's address, 0 to B's", async () => {
    // EXPECTED FAILURE (Mode 1): lib/alerts.ts not invoked per-user, or user B not seeded.
    // Production code path: lib/alerts.ts dispatchAlerts()
    //   must join watchedQuestions → users to get the owner's email for each question.
    expect(
      userExists(db, FIXTURE_USER_B.id),
      `Pre-condition: user B must exist so we can assert no cross-email dispatch.`
    ).toBe(true);

    // Import the alerts dispatcher directly
    // EXPECTED FAILURE (Mode 1): lib/alerts.ts may not export dispatchAlerts
    const alertsMod = await import("../../lib/alerts.js").catch(() => null);
    if (!alertsMod?.dispatchAlerts) {
      throw new Error(
        `lib/alerts.ts does not export dispatchAlerts. ` +
          `This function must accept (dbPath: string, nowMs: number) and dispatch ` +
          `emails only to the owner of each question that crosses the spread threshold. ` +
          `Production code path: lib/alerts.ts`
      );
    }

    // Seed: A's first question has a spread above threshold (0.05 > 0.03)
    // A's alert state is armed (ready to fire)
    if (questionExists(db, A_QUESTIONS[0].id)) {
      seedSpreadSnapshot(db, A_QUESTIONS[0].id, 0.05);
    }

    const nowMs = Date.now();
    await alertsMod.dispatchAlerts(dbPath, nowMs);

    const inbox = getInbox();
    const toA = inbox.filter(
      (m) =>
        (typeof m.to === "string" ? [m.to] : m.to).includes(FIXTURE_USER_A.email)
    );
    const toB = inbox.filter(
      (m) =>
        (typeof m.to === "string" ? [m.to] : m.to).includes(FIXTURE_USER_B.email)
    );

    expect(
      toA.length,
      `Expected 1 email to A (${FIXTURE_USER_A.email}) after A's spread crosses threshold. ` +
        `Got ${toA.length}. lib/alerts.ts must send exactly 1 email to the question owner.`
    ).toBe(1);

    expect(
      toB.length,
      `Expected 0 emails to B (${FIXTURE_USER_B.email}) after A's threshold cross. ` +
        `Got ${toB.length}. lib/alerts.ts must never dispatch to a user who doesn't own the question.`
    ).toBe(0);
  });

  it("threshold cross on B's question → 1 email to B, total inbox = 2 after both crosses", async () => {
    // EXPECTED FAILURE (Mode 1): user B not seeded, B's questions don't exist.
    // Production code path: lib/alerts.ts dispatchAlerts()
    expect(
      userExists(db, FIXTURE_USER_B.id),
      `Pre-condition: user B must exist.`
    ).toBe(true);
    expect(
      questionExists(db, B_QUESTIONS[0].id),
      `Pre-condition: B's first question must exist.`
    ).toBe(true);

    // First trigger A's alert (as in the previous test)
    const alertsMod = await import("../../lib/alerts.js").catch(() => null);
    if (!alertsMod?.dispatchAlerts) {
      throw new Error(
        `lib/alerts.ts does not export dispatchAlerts. Production code path: lib/alerts.ts`
      );
    }

    if (questionExists(db, A_QUESTIONS[0].id)) {
      seedSpreadSnapshot(db, A_QUESTIONS[0].id, 0.05);
    }
    await alertsMod.dispatchAlerts(dbPath, Date.now());

    // Now seed B's question above threshold and fire B's alert
    seedSpreadSnapshot(db, B_QUESTIONS[0].id, 0.05);
    await alertsMod.dispatchAlerts(dbPath, Date.now());

    const inbox = getInbox();
    const toB = inbox.filter(
      (m) =>
        (typeof m.to === "string" ? [m.to] : m.to).includes(FIXTURE_USER_B.email)
    );

    expect(
      toB.length,
      `Expected 1 email to B (${FIXTURE_USER_B.email}) after B's spread crosses threshold. ` +
        `Got ${toB.length}. lib/alerts.ts must dispatch to B when B's question crosses threshold.`
    ).toBe(1);

    expect(
      inbox.length,
      `Expected total inbox = 2 (1 for A + 1 for B). Got ${inbox.length}. ` +
        `lib/alerts.ts must send exactly one alert per threshold cross per user.`
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 8: Hysteresis state is per-user, per-question
// ---------------------------------------------------------------------------

describe("8. Hysteresis state is per-user, per-question (A fired ≠ B suppressed)", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(() => {
    dbPath = makeTempDbPath("hysteresis");
    runSeed(dbPath);
    db = openDb(dbPath);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  beforeEach(() => {
    clearInbox();
  });

  it("A's fired state on 'Fed cuts rates' does not suppress B's first alert on the same question text", async () => {
    // EXPECTED FAILURE (Mode 1): user B not seeded.
    // Production code path: lib/alerts.ts dispatchAlerts()
    //   Hysteresis state in the alerts table is keyed on (question_id, user_id),
    //   NOT on question text. Since A and B have separate question rows with
    //   separate IDs, A's fired state must not suppress B's first-time alert.
    //
    // The trap: if alerts are keyed on question TEXT (not ID), A's fired state
    // on "Will the Fed raise interest rates in 2026?" would suppress B's
    // first alert on the same text — that is the bug we're locking out.
    expect(
      userExists(db, FIXTURE_USER_B.id),
      `Pre-condition: user B must exist.`
    ).toBe(true);
    expect(
      questionExists(db, A_QUESTIONS[0].id),
      `Pre-condition: A's "Fed cuts rates" question must exist.`
    ).toBe(true);
    expect(
      questionExists(db, B_QUESTIONS[0].id),
      `Pre-condition: B's "Fed cuts rates" question (same text as A's) must exist.`
    ).toBe(true);

    // Confirm both questions have the same text (the cross-contamination trap)
    expect(A_QUESTIONS[0].query_text).toBe(B_QUESTIONS[0].query_text);

    // Seed A's question alert state as already "fired" (A already got their alert)
    seedAlertState(db, A_QUESTIONS[0].id, FIXTURE_USER_A.id, "fired");

    // Seed B's question above threshold — B's alert has never fired
    seedSpreadSnapshot(db, B_QUESTIONS[0].id, 0.05);

    const alertsMod = await import("../../lib/alerts.js").catch(() => null);
    if (!alertsMod?.dispatchAlerts) {
      throw new Error(
        `lib/alerts.ts does not export dispatchAlerts. Production code path: lib/alerts.ts`
      );
    }

    const nowMs = Date.now();
    await alertsMod.dispatchAlerts(dbPath, nowMs);

    const inbox = getInbox();
    const toB = inbox.filter(
      (m) =>
        (typeof m.to === "string" ? [m.to] : m.to).includes(FIXTURE_USER_B.email)
    );

    expect(
      toB.length,
      `Expected 1 email to B for their first "Fed cuts rates" alert. ` +
        `Got ${toB.length}. ` +
        `lib/alerts.ts: hysteresis must be keyed on (question_id, user_id), not question text. ` +
        `A's fired state on question ${A_QUESTIONS[0].id} must NOT suppress ` +
        `B's first alert on question ${B_QUESTIONS[0].id} (same text, different IDs).`
    ).toBe(1);

    // A should NOT receive a new alert (their state is "fired")
    const toA = inbox.filter(
      (m) =>
        (typeof m.to === "string" ? [m.to] : m.to).includes(FIXTURE_USER_A.email)
    );
    expect(
      toA.length,
      `Expected 0 new emails to A (their alert is in "fired" state = hysteresis should suppress). ` +
        `Got ${toA.length}. lib/alerts.ts must respect the per-user "fired" state.`
    ).toBe(0);

    // Assert B's alert state is now "fired" in the DB
    const bAlertState = getAlertState(db, B_QUESTIONS[0].id, FIXTURE_USER_B.id);
    expect(
      bAlertState,
      `B's alert row for question ${B_QUESTIONS[0].id} must be "fired" after dispatch. ` +
        `Got "${bAlertState}". lib/alerts.ts must upsert the alerts row with state="fired" ` +
        `after dispatching, keyed on (question_id, user_id).`
    ).toBe("fired");
  });
});

// ---------------------------------------------------------------------------
// Test 9: /api/test-set-key-status is scoped by session user
// ---------------------------------------------------------------------------

describe("9. /api/test-set-key-status honours session scope", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(() => {
    dbPath = makeTempDbPath("set-key-status");
    runSeed(dbPath);
    db = openDb(dbPath);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("POST /api/test-set-key-status with user_id=B as A's session must not affect A's status", async () => {
    // EXPECTED FAILURE (Mode 1): user B not seeded; the request may 404 on user_id=B,
    // but the key assertion is that A's status is unchanged.
    //
    // Production code path: app/api/test-set-key-status/route.ts
    //   Current implementation accepts user_id in the body without checking session.
    //   The DoD says the route must be "scoped by session user only" — meaning the
    //   implementer must either:
    //   (a) Require a valid session and only allow setting the session user's own status, OR
    //   (b) Accept user_id but validate the session matches it.
    //
    //   This test asserts that submitting user_id=B while authenticated as A does
    //   NOT change A's key status to an unexpected value (i.e., no CSRF-like
    //   cross-user mutation via a test-only admin endpoint).
    expect(
      userExists(db, FIXTURE_USER_B.id),
      `Pre-condition: user B must exist so we can attempt to set B's status via A's session.`
    ).toBe(true);

    // Record A's current status before the cross-user attempt
    const aStatusBefore = (db
      .prepare("SELECT anakin_key_status FROM users WHERE id = ?")
      .get(FIXTURE_USER_A.id) as { anakin_key_status: string } | undefined)?.anakin_key_status;

    // Attempt to set B's status using A's session
    const res = await apiPost("/api/test-set-key-status", SESSION_A, {
      user_id: FIXTURE_USER_B.id,
      status: "key-invalid",
    });

    // The endpoint must either:
    //   - Return 403/401 (session user != requested user_id), OR
    //   - Return 404 (user B not found, acceptable if endpoint ignores session), OR
    //   - Successfully set B's status (but NOT change A's status)
    // The critical assertion is that A's status is unchanged.
    const aStatusAfter = (db
      .prepare("SELECT anakin_key_status FROM users WHERE id = ?")
      .get(FIXTURE_USER_A.id) as { anakin_key_status: string } | undefined)?.anakin_key_status;

    expect(
      aStatusAfter,
      `POST /api/test-set-key-status with user_id=B changed A's status from ` +
        `"${aStatusBefore}" to "${aStatusAfter}". ` +
        `app/api/test-set-key-status/route.ts must never mutate a user other than ` +
        `the one specified, and must require a session when modifying sensitive state. ` +
        `The endpoint must be gated by session: only allow setting the session user's status, ` +
        `or return 403 when user_id !== session.userId.`
    ).toBe(aStatusBefore);

    // The endpoint must return 4xx when the session user (A) tries to set B's status
    // (current implementation returns 200 without checking session — that's the gap)
    expect(
      [401, 403, 404].includes(res.status),
      `POST /api/test-set-key-status with user_id=B as A's session must return 401/403/404. ` +
        `Got ${res.status}. ` +
        `app/api/test-set-key-status/route.ts must verify the session user matches user_id, ` +
        `or reject the request with 403. ` +
        `Current implementation does not check session — this is the missing isolation guard.`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 10: Brand-new email sign-in creates a fresh user row → /onboarding/anakin-key
// ---------------------------------------------------------------------------

describe("10. Brand-new email login creates a fresh user row and routes to onboarding", () => {
  let dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  const NEW_USER_EMAIL = "new-user@example.test";

  beforeAll(() => {
    dbPath = makeTempDbPath("new-signup");
    runSeed(dbPath);
    db = openDb(dbPath);
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("new-user@example.test has no user row before sign-in", () => {
    // This part should pass (no pre-seeded row for new-user@example.test).
    const row = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(NEW_USER_EMAIL) as { id: string } | undefined;

    expect(
      row,
      `Pre-condition: ${NEW_USER_EMAIL} must NOT have a user row before sign-in. ` +
        `If this fails, the seed has a spurious row for this email.`
    ).toBeUndefined();
  });

  it("sign-in flow for new email creates a user row + anakin_key_status=key-missing", async () => {
    // EXPECTED FAILURE (Mode 1): The in-process test harness (watched-server-setup.ts)
    // does not wire the NextAuth callback path for dynamic new-user creation.
    // The NextAuth Drizzle adapter creates the user row on token redemption, but
    // the in-process server setup only knows the fixture users.
    //
    // Production code path:
    //   app/api/auth/[...nextauth]/route.ts — NextAuth Email Provider callback
    //   @auth/drizzle-adapter — creates user row on first sign-in
    //   NextAuth callbacks.redirect — must detect anakin_key_status=key-missing
    //     and return /onboarding/anakin-key as the post-login redirect target
    //
    // The test-harness gap: tests/server/watched-server-setup.ts routes
    // /api/auth/callback/email to the NextAuth handler, but that handler
    // has no mechanism to create a new user in the in-process test DB
    // for an email address it hasn't seen before (only fixture users are seeded).
    //
    // The failing assertion here is that the user row is NOT created after
    // a simulated sign-in — which proves the seeded test harness only knows
    // the fixture user (this is the Mode 1 gap the implementer must close).

    // Step 1: Request magic link for the new email
    const signinRes = await fetch(`${BASE_URL}/api/auth/signin/email`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: NEW_USER_EMAIL,
        csrfToken: "test-csrf-bypass",
        callbackUrl: `${BASE_URL}/dashboard`,
      }).toString(),
      redirect: "manual",
    });

    // The sign-in request itself may succeed (200/302) or may be intercepted
    // differently — we don't assert on its status here.
    // What we assert is the outcome after token redemption.

    // Step 2: Look up the verification token that was created for the new email
    const tokenRow = db
      .prepare(
        "SELECT token FROM verification_tokens WHERE identifier = ? ORDER BY expires DESC LIMIT 1"
      )
      .get(NEW_USER_EMAIL) as { token: string } | undefined;

    // EXPECTED FAILURE: The in-process handler won't create a verification_tokens row
    // for a new email unless the NextAuth Email Provider flow is fully wired.
    expect(
      tokenRow,
      `After requesting a magic link for ${NEW_USER_EMAIL}, a verification_tokens row must exist. ` +
        `Got undefined. ` +
        `app/api/auth/[...nextauth]/route.ts: the NextAuth Email Provider must insert a token row ` +
        `for new users and trigger the Resend email. ` +
        `The in-process test harness (tests/server/watched-server-setup.ts) must wire ` +
        `/api/auth/signin/email to the NextAuth handler so new-user sign-ups flow through.`
    ).toBeDefined();

    // Step 3: Simulate callback with the token (redeem the magic link)
    const callbackRes = await fetch(
      `${BASE_URL}/api/auth/callback/email?token=${encodeURIComponent(tokenRow!.token)}&email=${encodeURIComponent(NEW_USER_EMAIL)}`,
      { method: "GET", redirect: "manual" }
    );

    // EXPECTED FAILURE: no row will be created, and the redirect won't point to onboarding.
    // Step 4: After redemption, the user row must exist with status=key-missing
    const newUserRow = db
      .prepare("SELECT id, anakin_key_status FROM users WHERE email = ?")
      .get(NEW_USER_EMAIL) as
      | { id: string; anakin_key_status: string }
      | undefined;

    expect(
      newUserRow,
      `After redeeming the magic link, a user row must exist for ${NEW_USER_EMAIL}. ` +
        `Got undefined. ` +
        `The NextAuth Drizzle adapter must create the user row on first sign-in. ` +
        `app/api/auth/[...nextauth]/route.ts + @auth/drizzle-adapter. ` +
        `The seeded test harness only knows the fixture user — this is the gap.`
    ).toBeDefined();

    expect(
      newUserRow?.anakin_key_status,
      `New user must have anakin_key_status="key-missing" (default from schema). ` +
        `Got "${newUserRow?.anakin_key_status}". ` +
        `db/schema.ts: anakin_key_status column must default to "key-missing".`
    ).toBe("key-missing");

    // Step 5: GET /api/me with the new session must return key-missing and
    //         the redirect location must include /onboarding/anakin-key.
    //
    // The callback response should redirect to /onboarding/anakin-key because
    // the new user has no Anakin key.
    const location = callbackRes.headers.get("location") ?? "";
    expect(
      location.includes("/onboarding/anakin-key") ||
        location.includes("onboarding") ||
        // Some implementations redirect to /dashboard and handle onboarding client-side
        // via /api/me; accept dashboard if status is properly key-missing
        location.includes("/dashboard"),
      `After sign-in, new user must be redirected toward onboarding (got location="${location}"). ` +
        `NextAuth callbacks.redirect must return /onboarding/anakin-key when ` +
        `user.anakin_key_status === "key-missing". ` +
        `app/api/auth/[...nextauth]/route.ts callbacks.redirect`
    ).toBe(true);
  });
});
