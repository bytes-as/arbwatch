/**
 * tests/history/history.test.ts
 *
 * Mode 1 (pre-implementation) — ALL 7 tests MUST FAIL until:
 *   - db/schema.ts adds a `spread_history` table
 *   - The cron handler (app/api/cron/refresh-spreads/route.ts) appends a row
 *     to `spread_history` on every tick (in addition to upserting spread_snapshots)
 *   - A retention job (or the cron handler itself) prunes rows older than
 *     HISTORY_RETENTION_DAYS days
 *   - app/api/watched/[id]/history/route.ts implements GET (auth-gated, 7-day cap)
 *
 * DoD items covered:
 *   #1  — schema: spread_history table exists with correct columns
 *   #2  — append-only: 3 cron ticks → 3 rows (not 1 upserted)
 *   #3  — snapshot regression: spread_snapshots still has 1 row per question after 3 ticks
 *   #4  — null spread written verbatim (not omitted)
 *   #5  — retention pruning: rows older than 8 days are removed; window locked as a constant
 *   #6  — CASCADE on watched_question delete: spread_history rows removed too
 *   #7  — GET /api/watched/:id/history: auth-gated, ASC sort, 7-day cap, 404 for other user
 *
 * Architecture references:
 *   - db/schema.ts         — existing tables: watched_questions, spread_snapshots
 *   - lib/cron.ts          — cron helpers (clearIdempotencyCache, computeSpreadForQuestion)
 *   - db/client.ts         — testDbUrlStore (AsyncLocalStorage for per-test DB isolation)
 *   - scripts/seed.ts      — runs migrations + inserts fixture users/questions
 *   - tests/cron/helpers/cron-fixtures.ts — shared fixture constants
 *
 * Test strategy:
 *   - Each describe group gets its own temp SQLite DB seeded with scripts/seed.ts
 *   - cron handler is invoked in-process via testDbUrlStore.run() (same pattern as
 *     tests/cron/refresh-spreads.test.ts)
 *   - spread_history rows are queried directly via better-sqlite3
 *   - WIRE_MODE=fixtures ensures no live Anakin/Wire calls
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  FIXTURE_USER_WITH_KEY,
  FIXTURE_QUESTIONS,
  TEST_APP_ENCRYPTION_KEY,
  TEST_CRON_SECRET,
  CRON_ROUTE,
} from "../cron/helpers/cron-fixtures";

// ---------------------------------------------------------------------------
// Retention constant — locked here; the implementation must import or mirror
// this exact value (8 days).
//
// Rationale: 7 days is the display window; an 8-day retention gives 24 hours
// of buffer so a brief cron outage does not immediately expose a gap at the
// left edge of the 7-day sparkline window on the next successful tick.
// ---------------------------------------------------------------------------

/**
 * Number of days of spread_history rows retained by the pruning job.
 * The implementation must prune rows with computed_at < (now - HISTORY_RETENTION_DAYS * 86400s).
 * Locked as 8 days (not 7) to give a 24-hour buffer beyond the 7-day display window.
 */
export const HISTORY_RETENTION_DAYS = 8;

// ---------------------------------------------------------------------------
// Project structure constants
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const SEED_SCRIPT = join(REPO_ROOT, "scripts", "seed.ts");

// ---------------------------------------------------------------------------
// Expected schema contract
// ---------------------------------------------------------------------------

export const SPREAD_HISTORY_TABLE = "spread_history";

export const SPREAD_HISTORY_COLUMNS = [
  "id",           // uuid text PK
  "question_id",  // FK → watched_questions.id ON DELETE CASCADE
  "spread",       // real nullable
  "computed_at",  // integer timestamp (Unix seconds)
] as const;

// ---------------------------------------------------------------------------
// Fixture question used across all DB tests
// ---------------------------------------------------------------------------

/**
 * We use the first fixture question from matching-queries.yaml ("Fed cuts rates June 2026").
 * It has 4 platform matches already seeded, so the cron will make Wire calls and write a spread.
 */
const FIXTURE_Q = FIXTURE_QUESTIONS[0];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(suffix: string): string {
  const dir = join(tmpdir(), "predmkt-arb-history-tests");
  mkdirSync(dir, { recursive: true });
  return join(dir, `history-${suffix}-${process.pid}.db`);
}

function runSeed(targetDbPath: string): void {
  execFileSync("npx", ["tsx", SEED_SCRIPT], {
    env: {
      ...process.env,
      DATABASE_URL: `file:${targetDbPath}`,
      WIRE_MODE: "fixtures",
      APP_ENCRYPTION_KEY: TEST_APP_ENCRYPTION_KEY,
      NODE_ENV: "test",
      PREDMKT_CRON_TEST: "true",
    },
    cwd: REPO_ROOT,
    stdio: "pipe",
    timeout: 30_000,
  });
}

/**
 * Invoke the cron route in-process via testDbUrlStore so the handler picks up
 * the correct per-test SQLite file.
 */
async function invokeCronHandler(dbPath: string): Promise<Response> {
  const { NextRequest } = await import("next/server");
  const mod = await import("../../app/api/cron/refresh-spreads/route.js");
  const { testDbUrlStore } = await import("../../db/client.js");
  const { clearIdempotencyCache } = await import("../../lib/cron.js");

  // Clear in-process idempotency cache so each tick is treated as a fresh run
  clearIdempotencyCache();

  const url = `http://localhost:3000${CRON_ROUTE}`;
  const req = new NextRequest(url, {
    method: "GET",
    headers: { "x-cron-secret": TEST_CRON_SECRET },
  });

  return testDbUrlStore.run(`file:${dbPath}`, async () => {
    const handler = (mod.GET ?? mod.POST) as
      | ((req: unknown) => Promise<Response>)
      | undefined;
    if (!handler) {
      throw new Error(
        "app/api/cron/refresh-spreads/route.ts does not export GET or POST."
      );
    }
    return handler(req);
  });
}

/**
 * Query spread_history rows for a question from a test DB.
 * Throws a descriptive error if the table does not exist, to clearly identify the
 * failing pre-condition (schema not yet created).
 */
function getHistoryRows(
  db: InstanceType<typeof Database>,
  questionId: string
): Array<{ id: string; question_id: string; spread: number | null; computed_at: number }> {
  try {
    return db
      .prepare(
        `SELECT id, question_id, spread, computed_at
         FROM ${SPREAD_HISTORY_TABLE}
         WHERE question_id = ?
         ORDER BY computed_at ASC`
      )
      .all(questionId) as Array<{
      id: string;
      question_id: string;
      spread: number | null;
      computed_at: number;
    }>;
  } catch (err) {
    throw new Error(
      `Failed to query ${SPREAD_HISTORY_TABLE} for question_id="${questionId}". ` +
        `Table does not exist — add it to db/schema.ts and run a migration. ` +
        `Required columns: id (text PK), question_id (text FK → watched_questions), ` +
        `spread (real nullable), computed_at (integer). ` +
        `Original error: ${(err as Error).message}`
    );
  }
}

// ---------------------------------------------------------------------------
// DoD #1 — Schema: spread_history table exists with correct columns
// ---------------------------------------------------------------------------

describe("DoD #1 — Schema: spread_history table", () => {
  let dbPath: string;
  let db: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("schema");
    runSeed(dbPath);
    db = new Database(dbPath);
  });

  afterAll(() => {
    db.close();
  });

  it("spread_history table exists in the DB", () => {
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      )
      .get(SPREAD_HISTORY_TABLE) as { name: string } | undefined;

    expect(
      row,
      `Table '${SPREAD_HISTORY_TABLE}' not found in sqlite_master. ` +
        `Add it to db/schema.ts (or a new Drizzle migration) with columns: ` +
        `id uuid PK, question_id FK → watched_questions ON DELETE CASCADE, ` +
        `spread REAL nullable, computed_at INTEGER timestamp. ` +
        `Then run 'npm run db:generate && npm run db:migrate'.`
    ).toBeDefined();
  });

  it("spread_history has all required columns", () => {
    const cols = db
      .prepare(`PRAGMA table_info(${SPREAD_HISTORY_TABLE})`)
      .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;

    const colNames = cols.map((c) => c.name);

    for (const required of SPREAD_HISTORY_COLUMNS) {
      expect(
        colNames,
        `Column '${required}' missing from ${SPREAD_HISTORY_TABLE}. ` +
          `Found columns: [${colNames.join(", ")}]. ` +
          `Required: ${SPREAD_HISTORY_COLUMNS.join(", ")}.`
      ).toContain(required);
    }
  });

  it("spread_history.question_id has ON DELETE CASCADE referencing watched_questions", () => {
    const foreignKeys = db
      .prepare(`PRAGMA foreign_key_list(${SPREAD_HISTORY_TABLE})`)
      .all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;

    const fk = foreignKeys.find(
      (f) => f.from === "question_id" && f.table === "watched_questions"
    );

    expect(
      fk,
      `${SPREAD_HISTORY_TABLE}.question_id must have a FK → watched_questions. ` +
        `Found FKs: ${JSON.stringify(foreignKeys)}. ` +
        `Declare it with .references(() => watchedQuestions.id, { onDelete: 'cascade' }) in schema.ts.`
    ).toBeDefined();

    expect(
      fk?.on_delete?.toUpperCase(),
      `${SPREAD_HISTORY_TABLE}.question_id FK must use ON DELETE CASCADE. ` +
        `Got on_delete='${fk?.on_delete}'. ` +
        `Use { onDelete: 'cascade' } in Drizzle schema.`
    ).toBe("CASCADE");
  });
});

// ---------------------------------------------------------------------------
// DoD #2 — Append-only: 3 ticks → 3 rows
// ---------------------------------------------------------------------------

describe("DoD #2 — Append-only: 3 cron ticks produce 3 history rows", () => {
  let dbPath: string;
  let db: InstanceType<typeof Database>;

  beforeAll(async () => {
    dbPath = makeTempDbPath("append");
    runSeed(dbPath);
    db = new Database(dbPath);
  });

  afterAll(() => {
    db.close();
  });

  it("after 3 cron ticks, spread_history has exactly 3 rows for the fixture question", async () => {
    // Run 3 ticks with a small time gap to avoid idempotency suppression.
    // Because clearIdempotencyCache() is called inside invokeCronHandler(), each
    // tick is treated as a new invocation.
    await invokeCronHandler(dbPath);
    await invokeCronHandler(dbPath);
    await invokeCronHandler(dbPath);

    const rows = getHistoryRows(db, FIXTURE_Q.id);

    expect(
      rows.length,
      `Expected 3 rows in ${SPREAD_HISTORY_TABLE} for question_id="${FIXTURE_Q.id}" ` +
        `after 3 cron ticks, but found ${rows.length}. ` +
        `The cron handler must INSERT a new row into spread_history on every tick ` +
        `(append-only), not upsert. ` +
        `Rows found: ${JSON.stringify(rows)}`
    ).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// DoD #3 — Snapshot regression: spread_snapshots still has 1 row per question
// ---------------------------------------------------------------------------

describe("DoD #3 — Regression: spread_snapshots still upserts (1 row per question)", () => {
  let dbPath: string;
  let db: InstanceType<typeof Database>;

  beforeAll(async () => {
    dbPath = makeTempDbPath("snapshot-regression");
    runSeed(dbPath);
    db = new Database(dbPath);
    // Run 3 ticks
    await invokeCronHandler(dbPath);
    await invokeCronHandler(dbPath);
    await invokeCronHandler(dbPath);
  });

  afterAll(() => {
    db.close();
  });

  it("spread_snapshots still has exactly 1 row for the fixture question after 3 ticks", () => {
    let rows: unknown[];
    try {
      rows = db
        .prepare(
          `SELECT id FROM spread_snapshots WHERE question_id = ?`
        )
        .all(FIXTURE_Q.id) as unknown[];
    } catch (err) {
      throw new Error(
        `Failed to query spread_snapshots for question_id="${FIXTURE_Q.id}". ` +
          `Original error: ${(err as Error).message}`
      );
    }

    expect(
      rows.length,
      `spread_snapshots should have exactly 1 row for question_id="${FIXTURE_Q.id}" ` +
        `after 3 ticks (upsert semantics), but found ${rows.length}. ` +
        `Do not change the upsert logic in spread_snapshots when adding spread_history.`
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DoD #4 — Null spread written verbatim
// ---------------------------------------------------------------------------

describe("DoD #4 — Null spread is written verbatim to spread_history", () => {
  let dbPath: string;
  let db: InstanceType<typeof Database>;

  beforeAll(async () => {
    dbPath = makeTempDbPath("null-spread");
    runSeed(dbPath);
    db = new Database(dbPath);
  });

  afterAll(() => {
    db.close();
  });

  it("a question with only 1 platform match gets a history row with spread = null", async () => {
    // Insert a single-platform question directly so we can force a null spread
    const singlePlatformQuestionId = "40000000-0000-0000-0000-000000000001";
    const nowSec = Math.floor(Date.now() / 1000);

    db.prepare(
      `INSERT INTO watched_questions (id, user_id, query_text, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).run(
      singlePlatformQuestionId,
      FIXTURE_USER_WITH_KEY.id,
      "Will null spread be written verbatim?",
      nowSec
    );

    // Insert exactly 1 match (Kalshi only) so computeSpread returns null
    db.prepare(
      `INSERT INTO question_matches (id, question_id, platform, market_id, market_url, implied_yes_prob, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(question_id, platform) DO NOTHING`
    ).run(
      "40000000-0000-0000-0000-000000000011",
      singlePlatformQuestionId,
      "kalshi",
      "kalshi-null-test",
      "https://kalshi.com/null-test",
      0.42,
      nowSec
    );

    await invokeCronHandler(dbPath);

    const rows = getHistoryRows(db, singlePlatformQuestionId);

    expect(
      rows.length,
      `Expected at least 1 history row for single-platform question after a cron tick. ` +
        `Got ${rows.length}. ` +
        `The cron must write a history row even when spread is null (1 platform case).`
    ).toBeGreaterThanOrEqual(1);

    const latestRow = rows[rows.length - 1];

    expect(
      latestRow.spread,
      `spread_history row has spread=${latestRow.spread}, expected null. ` +
        `When a question has only 1 platform match, spread must be null — ` +
        `not zero, not omitted. The cron must write the null verbatim into the row.`
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DoD #5 — Retention pruning: rows older than HISTORY_RETENTION_DAYS are removed
// ---------------------------------------------------------------------------

describe("DoD #5 — Retention pruning (8-day window)", () => {
  let dbPath: string;
  let db: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("retention");
    runSeed(dbPath);
    db = new Database(dbPath);
  });

  afterAll(() => {
    db.close();
  });

  it(
    `HISTORY_RETENTION_DAYS constant equals 8 ` +
      `(7-day display + 1-day buffer so brief cron outages do not gap the sparkline)`,
    () => {
      expect(
        HISTORY_RETENTION_DAYS,
        `HISTORY_RETENTION_DAYS must be 8 (not ${HISTORY_RETENTION_DAYS}). ` +
          `See inline comment: 8 days = 7-day display window + 1-day buffer.`
      ).toBe(8);
    }
  );

  it("rows older than 8 days are pruned; rows within 8 days are kept", async () => {
    const questionId = FIXTURE_Q.id;
    const nowSec = Math.floor(Date.now() / 1000);
    const dayInSec = 86_400;

    // Insert 10 synthetic history rows spanning 1..10 days ago
    // Days 1–8: within retention window → should survive
    // Days 9–10: outside retention window → should be pruned
    const insertHistory = db.prepare(
      `INSERT INTO ${SPREAD_HISTORY_TABLE} (id, question_id, spread, computed_at)
       VALUES (?, ?, ?, ?)`
    );

    const insertedIds: string[] = [];
    for (let daysAgo = 1; daysAgo <= 10; daysAgo++) {
      const id = `50000000-0000-0000-${String(daysAgo).padStart(4, "0")}-000000000001`;
      const computedAt = nowSec - daysAgo * dayInSec;
      try {
        insertHistory.run(id, questionId, 0.05, computedAt);
        insertedIds.push(id);
      } catch (err) {
        throw new Error(
          `Cannot insert into ${SPREAD_HISTORY_TABLE} — table likely does not exist. ` +
            `Add it to db/schema.ts. Original error: ${(err as Error).message}`
        );
      }
    }

    // Trigger a cron tick — the cron (or embedded retention job) must prune stale rows
    await invokeCronHandler(dbPath);

    const remaining = db
      .prepare(
        `SELECT computed_at FROM ${SPREAD_HISTORY_TABLE}
         WHERE question_id = ? AND id IN (${insertedIds.map(() => "?").join(",")})
         ORDER BY computed_at ASC`
      )
      .all(questionId, ...insertedIds) as Array<{ computed_at: number }>;

    const cutoffSec = nowSec - HISTORY_RETENTION_DAYS * dayInSec;

    const staleRows = remaining.filter((r) => r.computed_at < cutoffSec);

    expect(
      staleRows.length,
      `After cron tick, found ${staleRows.length} stale rows (computed_at < now - ${HISTORY_RETENTION_DAYS} days). ` +
        `Expected 0. ` +
        `The cron or a standalone retention function must DELETE FROM ${SPREAD_HISTORY_TABLE} ` +
        `WHERE computed_at < (unixepoch() - ${HISTORY_RETENTION_DAYS} * 86400). ` +
        `Rows still present with computed_at values: ${JSON.stringify(staleRows.map((r) => r.computed_at))}`
    ).toBe(0);

    // Rows from days 1–8 must survive (within retention window)
    const freshRows = remaining.filter((r) => r.computed_at >= cutoffSec);
    expect(
      freshRows.length,
      `Expected rows within the ${HISTORY_RETENTION_DAYS}-day window to survive pruning, ` +
        `but only ${freshRows.length} survived (should be 8 from the synthetic inserts, ` +
        `plus any rows added by the cron tick itself).`
    ).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// DoD #6 — CASCADE: deleting a watched_question removes its history rows
// ---------------------------------------------------------------------------

describe("DoD #6 — CASCADE: watched_question delete removes spread_history rows", () => {
  let dbPath: string;
  let db: InstanceType<typeof Database>;

  beforeAll(async () => {
    dbPath = makeTempDbPath("cascade");
    runSeed(dbPath);
    db = new Database(dbPath);
    // Populate history rows for the fixture question
    await invokeCronHandler(dbPath);
  });

  afterAll(() => {
    db.close();
  });

  it("spread_history rows are removed when the watched_question is deleted", () => {
    const questionId = FIXTURE_Q.id;

    // Verify there are some history rows before deletion
    const before = getHistoryRows(db, questionId);
    expect(
      before.length,
      `Expected at least 1 history row before deletion, got ${before.length}. ` +
        `The cron must have written rows in beforeAll. Check DoD #2 as a dependency.`
    ).toBeGreaterThanOrEqual(1);

    // Enable FK enforcement and delete the watched_question
    db.pragma("foreign_keys = ON");
    db.prepare(`DELETE FROM watched_questions WHERE id = ?`).run(questionId);

    const after = getHistoryRows(db, questionId);

    expect(
      after.length,
      `After deleting watched_question id="${questionId}", expected 0 spread_history rows ` +
        `but found ${after.length}. ` +
        `Ensure ${SPREAD_HISTORY_TABLE}.question_id has ON DELETE CASCADE. ` +
        `Also ensure PRAGMA foreign_keys = ON is set in the application DB connection ` +
        `(check db/client.ts — SQLite requires explicit FK enforcement).`
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DoD #7 — GET /api/watched/:id/history endpoint
// ---------------------------------------------------------------------------

describe("DoD #7 — GET /api/watched/:id/history endpoint", () => {
  let dbPath: string;
  let db: InstanceType<typeof Database>;

  const FIXTURE_SESSION_TOKEN =
    process.env.FIXTURE_SESSION_TOKEN ??
    "fixture-session-token-do-not-use-in-prod";

  const FIXTURE_SESSION_TOKEN_B =
    process.env.FIXTURE_SESSION_TOKEN_B ??
    "fixture-session-token-b-do-not-use-in-prod";

  /**
   * Invoke the history endpoint in-process via testDbUrlStore.
   * The endpoint does not exist yet — this will throw pre-implementation.
   */
  async function invokeHistoryEndpoint(
    questionId: string,
    sessionToken: string | null,
    dbPath: string
  ): Promise<Response> {
    const { NextRequest } = await import("next/server");
    const { testDbUrlStore } = await import("../../db/client.js");

    // Dynamic import — will throw if the route does not yet exist
    const mod = await import(
      "../../app/api/watched/[id]/history/route.js"
    ).catch(() => {
      throw new Error(
        "app/api/watched/[id]/history/route.ts does not exist. " +
          "Create a GET handler that returns the question's spread_history " +
          "as [{ spread, computed_at }, ...] sorted ASC by computed_at, " +
          "capped at the last 7 days. Auth-gate with session cookie. " +
          "Return 404 for another user's question."
      );
    });

    const cookieHeader = sessionToken
      ? `next-auth.session-token=${sessionToken}`
      : "";

    const url = `http://localhost:3000/api/watched/${questionId}/history`;
    const req = new NextRequest(url, {
      method: "GET",
      headers: sessionToken ? { cookie: cookieHeader } : {},
    });

    return testDbUrlStore.run(`file:${dbPath}`, async () => {
      const handler = (mod.GET) as
        | ((
            req: unknown,
            ctx: { params: { id: string } }
          ) => Promise<Response>)
        | undefined;
      if (!handler) {
        throw new Error(
          "app/api/watched/[id]/history/route.ts does not export GET."
        );
      }
      return handler(req, { params: { id: questionId } });
    });
  }

  beforeAll(async () => {
    dbPath = makeTempDbPath("history-api");
    runSeed(dbPath);
    db = new Database(dbPath);

    // Seed a few history rows for the fixture question directly
    const nowSec = Math.floor(Date.now() / 1000);
    const questionId = FIXTURE_Q.id;

    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT OR IGNORE INTO ${SPREAD_HISTORY_TABLE} (id, question_id, spread, computed_at)
         VALUES (?, ?, ?, ?)`
      ).run(
        `60000000-0000-0000-000${i}-000000000001`,
        questionId,
        0.03 + i * 0.005,
        nowSec - (4 - i) * 3600 // 4h, 3h, 2h, 1h, 0h ago — ASC order
      );
    }

    // Also insert one row older than 7 days — should be excluded from the response
    db.prepare(
      `INSERT OR IGNORE INTO ${SPREAD_HISTORY_TABLE} (id, question_id, spread, computed_at)
       VALUES (?, ?, ?, ?)`
    ).run(
      "60000000-0000-0000-0009-000000000001",
      questionId,
      0.01,
      nowSec - 8 * 86_400 // 8 days ago — outside the 7-day cap
    );
  });

  afterAll(() => {
    db.close();
  });

  it("returns 401 without a session cookie", async () => {
    const res = await invokeHistoryEndpoint(FIXTURE_Q.id, null, dbPath);

    expect(
      res.status,
      `GET /api/watched/${FIXTURE_Q.id}/history without auth should return 401. ` +
        `Got ${res.status}. Auth-gate the endpoint with the standard session cookie check.`
    ).toBe(401);
  });

  it("returns an array of { spread, computed_at } sorted ASC by computed_at", async () => {
    const res = await invokeHistoryEndpoint(
      FIXTURE_Q.id,
      FIXTURE_SESSION_TOKEN,
      dbPath
    );

    expect(
      res.status,
      `GET /api/watched/${FIXTURE_Q.id}/history with valid session returned ${res.status}, expected 200.`
    ).toBe(200);

    const body = (await res.json()) as Array<{
      spread: number | null;
      computed_at: number;
    }>;

    expect(
      Array.isArray(body),
      `Response body must be an array, got: ${JSON.stringify(body)}`
    ).toBe(true);

    expect(
      body.length,
      `Expected at least 1 history entry in the response, got ${body.length}.`
    ).toBeGreaterThanOrEqual(1);

    // Each entry must have spread and computed_at
    for (const entry of body) {
      expect(
        "computed_at" in entry,
        `History entry missing 'computed_at' field: ${JSON.stringify(entry)}`
      ).toBe(true);
      expect(
        "spread" in entry,
        `History entry missing 'spread' field: ${JSON.stringify(entry)}`
      ).toBe(true);
    }

    // Must be sorted ASC by computed_at
    for (let i = 1; i < body.length; i++) {
      expect(
        body[i].computed_at >= body[i - 1].computed_at,
        `History response is not sorted ASC by computed_at. ` +
          `Entry [${i - 1}].computed_at=${body[i - 1].computed_at} > ` +
          `entry [${i}].computed_at=${body[i].computed_at}. ` +
          `Add ORDER BY computed_at ASC to the query.`
      ).toBe(true);
    }
  });

  it("response is capped at 7 days (excludes rows older than 7 days)", async () => {
    const res = await invokeHistoryEndpoint(
      FIXTURE_Q.id,
      FIXTURE_SESSION_TOKEN,
      dbPath
    );

    expect(res.status).toBe(200);

    const body = (await res.json()) as Array<{
      spread: number | null;
      computed_at: number;
    }>;

    const nowSec = Math.floor(Date.now() / 1000);
    const cutoffSec = nowSec - 7 * 86_400;

    const tooOld = body.filter((e) => e.computed_at < cutoffSec);

    expect(
      tooOld.length,
      `Response includes ${tooOld.length} entries older than 7 days. ` +
        `The endpoint must cap results to computed_at >= (now - 7 * 86400). ` +
        `Stale entries: ${JSON.stringify(tooOld)}`
    ).toBe(0);
  });

  it("returns 404 for a question owned by a different user", async () => {
    // FIXTURE_Q is owned by FIXTURE_USER_WITH_KEY (user 000...0001).
    // The session token for user B (000...0002 / "nokey") must not see it.
    const res = await invokeHistoryEndpoint(
      FIXTURE_Q.id,
      FIXTURE_SESSION_TOKEN_B,
      dbPath
    );

    expect(
      res.status,
      `GET /api/watched/${FIXTURE_Q.id}/history with user-B session returned ${res.status}, ` +
        `expected 404. The endpoint must scope the lookup to WHERE id = :id AND user_id = :sessionUserId. ` +
        `Return 404 (not 403) to avoid leaking row existence.`
    ).toBe(404);
  });
});
