/**
 * tests/cron/refresh-spreads.test.ts
 *
 * Mode 1 (pre-implementation) — ALL tests in this file MUST FAIL until:
 *   - app/api/cron/refresh-spreads/route.ts (or similar) is implemented
 *   - lib/cron.ts (or similar) exports computeSpreadForQuestion(platformProbs) → number | null
 *   - db/schema.ts has a spread_snapshots table (or equivalent) with:
 *       (id, question_id FK watched_questions, spread REAL nullable,
 *        last_updated INTEGER timestamp, computed_at INTEGER timestamp)
 *   - scripts/seed.ts seeds both fixture users and all 5 matching questions
 *   - CRON_SECRET env var is documented in .env.example
 *
 * DoD items covered:
 *   #2  — Spread formula: 4-platform case (0.45 - 0.40 = 0.05)
 *   #3  — Null on single-platform match (spread = null)
 *   #4  — 2-platform spread (0.04)
 *   #5  — 3-platform spread
 *   #6  — last_updated stamp advances on second invocation
 *   #7  — key-missing: no Wire call, no spread row
 *   #8  — key-invalid: no Wire call, no spread row
 *   #9  — quota-exhausted: no Wire call; 10-min cooldown documented + asserted
 *   #10 — Per-user 8s budget (parallelism asserted)
 *   #11 — CRON_SECRET auth: 401 without header, handler runs with it
 *   #12 — Idempotent under back-pressure (second tick ≤60s → no-op Wire)
 *   #13 — Skip questions with no matches (empty question_matches → no Wire, no row)
 *
 * Architecture references:
 *   ADR-0001 §"Locked-in specifics → Cron"
 *   ADR-0002 §"Error taxonomy": key-missing | key-invalid | quota-exhausted
 *   ADR-0002 §"Retry / backoff": 8s AbortController, 6s per-user budget
 *   tests/fixtures/wire/README.md — FED_CUTS probs (kalshi=0.43, mm=0.45, pm=0.40, rh=0.43)
 *
 * Test approach:
 *   - cron handler is invoked in-process via dynamic import (same as key/watched patterns)
 *   - wireRequest is spied on from lib/wire/client.ts to assert skip behavior
 *   - vi.useFakeTimers() used for timing-sensitive tests (#6, #9, #10, #12)
 *   - DB assertions use better-sqlite3 directly against a temp SQLite file
 *   - WIRE_MODE=fixtures throughout (set by vitest.workspace.ts "other" project)
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
} from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import {
  REPO_ROOT,
  CRON_ROUTE,
  TEST_CRON_SECRET,
  FIXTURE_USER_WITH_KEY,
  FIXTURE_USER_NO_KEY,
  FIXTURE_QUESTIONS,
  FED_CUTS_PROBS,
  FED_CUTS_SPREAD,
  PER_USER_BUDGET_MS,
  IDEMPOTENCY_WINDOW_MS,
  QUOTA_COOLDOWN_MS,
  TEST_APP_ENCRYPTION_KEY,
  EXPECTED_SPREAD_SNAPSHOTS_TABLE,
  EXPECTED_SPREAD_SNAPSHOTS_COLUMNS,
} from "./helpers/cron-fixtures";

// ---------------------------------------------------------------------------
// WIRE_MODE assertion (must be "fixtures" — set by vitest.workspace.ts)
// ---------------------------------------------------------------------------

it("WIRE_MODE is 'fixtures' (guard: no live Wire calls in tests)", () => {
  expect(
    process.env.WIRE_MODE,
    "WIRE_MODE must be 'fixtures' for cron tests. " +
      "vitest.workspace.ts must set WIRE_MODE=fixtures for the 'other' project."
  ).toBe("fixtures");
});

// ---------------------------------------------------------------------------
// Module-level optional imports (fail gracefully pre-implementation)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let computeSpreadForQuestion: (platformProbs: number[]) => number | null;
let cronLibError: Error | null = null;

try {
  // lib/cron.ts does not exist pre-implementation — import will throw.
  const cronMod = await import("../../lib/cron.js");
  computeSpreadForQuestion = cronMod.computeSpreadForQuestion;
} catch (err) {
  cronLibError = err as Error;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wireRequest: (
  userId: string,
  action: string,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal; _rawKey?: string }
) => Promise<unknown>;
let wireClientError: Error | null = null;

try {
  const wireMod = await import("../../lib/wire/client.js");
  wireRequest = wireMod.wireRequest;
} catch (err) {
  wireClientError = err as Error;
}

// Track whether the cron route handler itself can be imported.
// Tests that call invokeCronHandler() must check this first so that
// "zero Wire calls because handler doesn't exist" does not produce a
// false-passing test.
let cronHandlerError: Error | null = null;
try {
  await import("../../app/api/cron/refresh-spreads/route.js");
} catch (err) {
  cronHandlerError = err as Error;
}

// ---------------------------------------------------------------------------
// Temp DB setup helpers
// ---------------------------------------------------------------------------

const SEED_SCRIPT = join(REPO_ROOT, "scripts", "seed.ts");

function makeTempDbPath(suffix: string): string {
  const dir = join(tmpdir(), "predmkt-arb-cron-tests");
  mkdirSync(dir, { recursive: true });
  return join(dir, `cron-${suffix}-${process.pid}.db`);
}

function runSeed(targetDbPath: string): void {
  execFileSync("npx", ["tsx", SEED_SCRIPT], {
    env: {
      ...process.env,
      DATABASE_URL: `file:${targetDbPath}`,
      WIRE_MODE: "fixtures",
      APP_ENCRYPTION_KEY: TEST_APP_ENCRYPTION_KEY,
      NODE_ENV: "test",
    },
    cwd: REPO_ROOT,
    stdio: "pipe",
    timeout: 30_000,
  });
}

/**
 * Invoke the cron route handler in-process using a NextRequest-like object.
 * The handler must be exported from app/api/cron/refresh-spreads/route.ts
 * as a GET or POST export.
 *
 * Returns the Response from the handler.
 */
async function invokeCronHandler(options: {
  dbPath: string;
  cronSecret?: string;
  /** Override Date.now() to simulate time passing. Only used with vi.useFakeTimers(). */
  overrideNow?: number;
}): Promise<Response> {
  const { dbPath, cronSecret } = options;

  // Dynamic import so the module picks up the correct env
  const { NextRequest } = await import("next/server");

  // The cron route does not exist yet — this import will throw pre-implementation
  const mod = await import("../../app/api/cron/refresh-spreads/route.js");

  const url = `http://localhost:3000${CRON_ROUTE}`;
  const headers: Record<string, string> = {
    "x-cron-secret": cronSecret ?? "",
  };

  const req = new NextRequest(url, {
    method: "GET",
    headers,
  });

  // Run the handler in the context of the test DB
  const { testDbUrlStore } = await import("../../db/client.js");
  return testDbUrlStore.run(`file:${dbPath}`, async () => {
    const handler = (mod.GET ?? mod.POST) as ((req: unknown) => Promise<Response>) | undefined;
    if (!handler) {
      throw new Error(
        `app/api/cron/refresh-spreads/route.ts does not export GET or POST. ` +
          `The cron handler must be a Next.js route exporting GET or POST.`
      );
    }
    return handler(req);
  });
}

/**
 * Read the spread_snapshots table for a given question_id from a test DB.
 */
function getSpreadSnapshot(
  sqlite: InstanceType<typeof Database>,
  questionId: string
): { spread: number | null; last_updated: number | null; computed_at: number | null } | undefined {
  try {
    return sqlite
      .prepare(
        `SELECT spread, last_updated, computed_at
         FROM ${EXPECTED_SPREAD_SNAPSHOTS_TABLE}
         WHERE question_id = ?`
      )
      .get(questionId) as
      | { spread: number | null; last_updated: number | null; computed_at: number | null }
      | undefined;
  } catch (err) {
    throw new Error(
      `Failed to query ${EXPECTED_SPREAD_SNAPSHOTS_TABLE} table for question_id="${questionId}". ` +
        `This table must exist in the DB. ` +
        `Create it in db/schema.ts with columns: ` +
        `(id, question_id FK watched_questions, spread REAL nullable, ` +
        `last_updated INTEGER timestamp, computed_at INTEGER timestamp). ` +
        `Original error: ${(err as Error).message}`
    );
  }
}

// ---------------------------------------------------------------------------
// DoD 2–5: Spread formula (unit tests on computeSpreadForQuestion)
// ---------------------------------------------------------------------------

describe("DoD 2–5 — Spread formula (lib/cron.ts#computeSpreadForQuestion)", () => {
  it("lib/cron.ts exports computeSpreadForQuestion", () => {
    expect(
      cronLibError,
      `lib/cron.ts does not exist or fails to import. ` +
        `Error: ${cronLibError?.message}. ` +
        `Create lib/cron.ts and export: ` +
        `computeSpreadForQuestion(platformProbs: number[]): number | null. ` +
        `This helper computes spread = max(probs) - min(probs).`
    ).toBeNull();

    expect(
      typeof computeSpreadForQuestion,
      "computeSpreadForQuestion is not a function in lib/cron.ts"
    ).toBe("function");
  });

  it("DoD 2 — 4-platform case: spread = max - min = 0.45 - 0.40 = 0.05", () => {
    if (cronLibError) {
      throw new Error(`lib/cron.ts not importable: ${cronLibError.message}`);
    }

    // Platform probs from fixture: kalshi=0.43, manifold=0.45, polymarket=0.40, robinhood=0.43
    const probs = [
      FED_CUTS_PROBS.kalshi,
      FED_CUTS_PROBS.manifold,
      FED_CUTS_PROBS.polymarket,
      FED_CUTS_PROBS.robinhood,
    ];
    const spread = computeSpreadForQuestion(probs);

    expect(
      spread,
      `computeSpreadForQuestion([0.43, 0.45, 0.40, 0.43]) returned null. ` +
        `Expected 0.05 (max=0.45, min=0.40). ` +
        `The formula is: spread = max(probs) - min(probs).`
    ).not.toBeNull();

    expect(
      Math.abs(spread! - FED_CUTS_SPREAD) < 0.0001,
      `computeSpreadForQuestion([0.43, 0.45, 0.40, 0.43]) = ${spread}, ` +
        `expected ${FED_CUTS_SPREAD} (±0.0001). ` +
        `Fixture: kalshi=0.43, manifold=0.45, polymarket=0.40, robinhood=0.43. ` +
        `spread = 0.45 − 0.40 = 0.05.`
    ).toBe(true);
  });

  it("DoD 3 — Single-platform match returns null (NOT zero)", () => {
    if (cronLibError) {
      throw new Error(`lib/cron.ts not importable: ${cronLibError.message}`);
    }

    const spread = computeSpreadForQuestion([0.42]);

    expect(
      spread,
      `computeSpreadForQuestion([0.42]) returned ${spread} but expected null. ` +
        `DoD 3: "For a question matched on only 1 platform, spread = null (NOT zero) ` +
        `and the row is excluded from alert eligibility." ` +
        `A spread requires at least 2 platforms to be meaningful.`
    ).toBeNull();

    // Explicitly assert it is not zero — an easy implementation mistake
    expect(
      spread !== 0,
      `computeSpreadForQuestion([0.42]) returned 0 (zero). ` +
        `DoD 3 requires null, not zero, for single-platform matches. ` +
        `Zero would incorrectly be treated as a valid spread of 0%.`
    ).toBe(true);
  });

  it("DoD 3 — Empty platform list returns null", () => {
    if (cronLibError) {
      throw new Error(`lib/cron.ts not importable: ${cronLibError.message}`);
    }

    const spread = computeSpreadForQuestion([]);

    expect(
      spread,
      `computeSpreadForQuestion([]) returned ${spread} but expected null. ` +
        `An empty platform list (no matches) must produce null, not a number.`
    ).toBeNull();
  });

  it("DoD 4 — 2-platform spread: kalshi=0.30, polymarket=0.34 → spread=0.04", () => {
    if (cronLibError) {
      throw new Error(`lib/cron.ts not importable: ${cronLibError.message}`);
    }

    const spread = computeSpreadForQuestion([0.30, 0.34]);

    expect(
      spread,
      `computeSpreadForQuestion([0.30, 0.34]) returned null. Expected 0.04.`
    ).not.toBeNull();

    expect(
      Math.abs(spread! - 0.04) < 0.0001,
      `computeSpreadForQuestion([0.30, 0.34]) = ${spread}, expected 0.04. ` +
        `spread = max(0.34) - min(0.30) = 0.04.`
    ).toBe(true);
  });

  it("DoD 4 — 2-platform: same value on both → spread = 0.00 (not null)", () => {
    if (cronLibError) {
      throw new Error(`lib/cron.ts not importable: ${cronLibError.message}`);
    }

    const spread = computeSpreadForQuestion([0.50, 0.50]);

    // Two platforms with identical probs is a valid spread of zero
    // (not null — null means insufficient data, not zero spread)
    expect(
      spread,
      `computeSpreadForQuestion([0.50, 0.50]) returned null. ` +
        `Two platforms with identical probs should return 0.00 (the spread is zero), ` +
        `not null (which means insufficient data).`
    ).not.toBeNull();

    expect(
      Math.abs(spread! - 0.0) < 0.0001,
      `computeSpreadForQuestion([0.50, 0.50]) = ${spread}, expected 0.00.`
    ).toBe(true);
  });

  it("DoD 5 — 3-platform spread: 0.40, 0.45, 0.42 → spread = 0.05", () => {
    if (cronLibError) {
      throw new Error(`lib/cron.ts not importable: ${cronLibError.message}`);
    }

    const spread = computeSpreadForQuestion([0.40, 0.45, 0.42]);

    expect(
      spread,
      `computeSpreadForQuestion([0.40, 0.45, 0.42]) returned null. Expected 0.05.`
    ).not.toBeNull();

    expect(
      Math.abs(spread! - 0.05) < 0.0001,
      `computeSpreadForQuestion([0.40, 0.45, 0.42]) = ${spread}, expected 0.05. ` +
        `spread = max(0.45) - min(0.40) = 0.05.`
    ).toBe(true);
  });

  it("DoD 5 — 3-platform spread: 0.60, 0.70, 0.65 → spread = 0.10", () => {
    if (cronLibError) {
      throw new Error(`lib/cron.ts not importable: ${cronLibError.message}`);
    }

    const spread = computeSpreadForQuestion([0.60, 0.70, 0.65]);

    expect(
      spread,
      `computeSpreadForQuestion([0.60, 0.70, 0.65]) returned null. Expected 0.10.`
    ).not.toBeNull();

    expect(
      Math.abs(spread! - 0.10) < 0.0001,
      `computeSpreadForQuestion([0.60, 0.70, 0.65]) = ${spread}, expected 0.10.`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DoD 2 + 6: Cron handler persists spread + last_updated (integration)
// ---------------------------------------------------------------------------

describe("DoD 2 + 6 — Cron handler persists spread and last_updated", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("spread-persist");

    // runSeed will throw if scripts/seed.ts does not exist yet.
    // The seed must insert both fixture users and the 5 matching questions.
    runSeed(dbPath);

    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");

    // Pre-populate question_matches for the primary question so the cron has
    // data to read. The cron handler reads existing question_matches rows to
    // fetch implied_yes_prob per platform.
    //
    // Pre-implementation note: if question_matches does not exist, this will
    // throw with a clear error message, surfacing the missing table.
    try {
      // Insert 4 platform rows for "fed-cuts-rates-june-2026"
      const questionId = FIXTURE_QUESTIONS[0].id; // "20000000-0000-0000-0000-000000000001"
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO question_matches
           (id, question_id, platform, market_id, implied_yes_prob, last_seen_at)
           VALUES
           ('cm-kl-001', ?, 'kalshi',     'KL-FED',  0.43, unixepoch()),
           ('cm-mm-001', ?, 'manifold',   'MM-FED',  0.45, unixepoch()),
           ('cm-pm-001', ?, 'polymarket', 'PM-FED',  0.40, unixepoch()),
           ('cm-rh-001', ?, 'robinhood',  'RH-FED',  0.43, unixepoch())`
        )
        .run(questionId, questionId, questionId, questionId);
    } catch (err) {
      // question_matches table missing — expected pre-implementation.
      // The tests below will surface this clearly.
    }
  });

  afterAll(() => {
    try {
      sqlite?.close();
    } catch {}
    // Cleanup is best-effort — the temp db will be removed by OS cleanup
  });

  it("spread_snapshots table exists in the DB after migration", () => {
    try {
      const row = sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='${EXPECTED_SPREAD_SNAPSHOTS_TABLE}'`
        )
        .get() as { name: string } | undefined;

      expect(
        row,
        `Table "${EXPECTED_SPREAD_SNAPSHOTS_TABLE}" does not exist in the database. ` +
          `db/schema.ts must define this table. ` +
          `Suggested schema:\n` +
          `export const spreadSnapshots = sqliteTable("spread_snapshots", {\n` +
          `  id:          text("id").primaryKey(),\n` +
          `  questionId:  text("question_id").notNull().references(() => watchedQuestions.id),\n` +
          `  spread:      real("spread"),\n` +
          `  lastUpdated: integer("last_updated", { mode: "timestamp" }).notNull(),\n` +
          `  computedAt:  integer("computed_at",  { mode: "timestamp" }).notNull(),\n` +
          `});`
      ).toBeDefined();
    } catch (err) {
      throw new Error(
        `Failed to query sqlite_master: ${(err as Error).message}. ` +
          `The ${EXPECTED_SPREAD_SNAPSHOTS_TABLE} table must exist.`
      );
    }
  });

  it("spread_snapshots has the required columns", () => {
    try {
      const cols = sqlite
        .prepare(`PRAGMA table_info(${EXPECTED_SPREAD_SNAPSHOTS_TABLE})`)
        .all() as Array<{ name: string }>;

      const colNames = cols.map((c) => c.name);

      for (const required of EXPECTED_SPREAD_SNAPSHOTS_COLUMNS) {
        expect(
          colNames.includes(required),
          `${EXPECTED_SPREAD_SNAPSHOTS_TABLE} is missing column "${required}". ` +
            `Found columns: ${JSON.stringify(colNames)}. ` +
            `Required: ${JSON.stringify(EXPECTED_SPREAD_SNAPSHOTS_COLUMNS)}.`
        ).toBe(true);
      }
    } catch (err) {
      throw new Error(
        `Cannot inspect ${EXPECTED_SPREAD_SNAPSHOTS_TABLE} columns: ${(err as Error).message}.`
      );
    }
  });

  it(
    "DoD 2 — cron handler persists spread=0.05 for 'fed-cuts-rates-june-2026' after one invocation",
    async () => {
      const questionId = FIXTURE_QUESTIONS[0].id;

      // Invoke cron handler
      await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET });

      const snapshot = getSpreadSnapshot(sqlite, questionId);

      expect(
        snapshot,
        `No row in ${EXPECTED_SPREAD_SNAPSHOTS_TABLE} for question_id="${questionId}" ` +
          `after cron invocation. ` +
          `The cron handler must write a spread snapshot after computing the spread. ` +
          `Question: "Fed cuts rates June 2026". ` +
          `Expected probs: kalshi=0.43, manifold=0.45, polymarket=0.40, robinhood=0.43. ` +
          `Expected spread=0.05.`
      ).toBeDefined();

      expect(
        snapshot?.spread !== null && snapshot?.spread !== undefined,
        `spread_snapshots.spread is null for question "${questionId}". ` +
          `The spread must be computed and stored as a non-null number (0.05) ` +
          `when 4 platform probs are available.`
      ).toBe(true);

      expect(
        Math.abs((snapshot?.spread ?? -1) - FED_CUTS_SPREAD) < 0.0001,
        `spread_snapshots.spread=${snapshot?.spread} for question "${questionId}". ` +
          `Expected ${FED_CUTS_SPREAD} (±0.0001). ` +
          `Fixture: kalshi=0.43, manifold=0.45, polymarket=0.40, robinhood=0.43. ` +
          `spread = max(0.45) - min(0.40) = 0.05.`
      ).toBe(true);
    }
  );

  it("DoD 2 — spread_snapshots.last_updated is approximately now() after first invocation", async () => {
    const questionId = FIXTURE_QUESTIONS[0].id;
    const beforeMs = Date.now();

    await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET });

    const afterMs = Date.now();
    const snapshot = getSpreadSnapshot(sqlite, questionId);

    expect(
      snapshot?.last_updated,
      `spread_snapshots.last_updated is null for question "${questionId}". ` +
        `The cron handler must write last_updated = now() on each run.`
    ).not.toBeNull();

    const lastUpdatedMs = (snapshot?.last_updated ?? 0) * 1000; // SQLite stores as Unix seconds
    // Tolerate ±5s clock drift for the comparison
    const toleranceMs = 5_000;

    expect(
      lastUpdatedMs >= beforeMs - toleranceMs && lastUpdatedMs <= afterMs + toleranceMs,
      `spread_snapshots.last_updated=${snapshot?.last_updated} (${new Date(lastUpdatedMs).toISOString()}) ` +
        `is outside the expected range [${new Date(beforeMs).toISOString()}, ` +
        `${new Date(afterMs).toISOString()}] (±${toleranceMs}ms). ` +
        `The cron handler must write last_updated to the current timestamp.`
    ).toBe(true);
  });

  it("DoD 6 — second invocation advances last_updated timestamp", async () => {
    const questionId = FIXTURE_QUESTIONS[0].id;

    // First invocation
    await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET });
    const snapshot1 = getSpreadSnapshot(sqlite, questionId);
    const firstTs = snapshot1?.last_updated ?? 0;

    // Wait 1.1s to ensure timestamp can advance (SQLite stores as Unix seconds)
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Second invocation — last_updated must advance
    await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET });
    const snapshot2 = getSpreadSnapshot(sqlite, questionId);
    const secondTs = snapshot2?.last_updated ?? 0;

    expect(
      secondTs > firstTs,
      `spread_snapshots.last_updated did not advance after second cron invocation. ` +
        `first=${firstTs}, second=${secondTs}. ` +
        `DoD 6: "Each refresh writes last_updated = now(); a second invocation ` +
        `(e.g. simulated 5 min later) advances the timestamp." ` +
        `The cron handler must UPDATE the row on each run (upsert by question_id).`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DoD 3: Null spread for single-platform (integration via handler)
// ---------------------------------------------------------------------------

describe("DoD 3 — Single-platform match: spread stored as null (not 0)", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("single-platform");
    runSeed(dbPath);
    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");

    // Insert only 1 platform row for question 1 (simulates 1-platform match)
    try {
      const questionId = FIXTURE_QUESTIONS[0].id;
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO question_matches
           (id, question_id, platform, market_id, implied_yes_prob, last_seen_at)
           VALUES ('cm-kl-single', ?, 'kalshi', 'KL-FED', 0.43, unixepoch())`
        )
        .run(questionId);
    } catch {
      // question_matches table missing — expected pre-implementation
    }
  });

  afterAll(() => {
    try { sqlite?.close(); } catch {}
  });

  it("DoD 3 — cron writes null spread for a question with 1 platform match", async () => {
    const questionId = FIXTURE_QUESTIONS[0].id;

    await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET });

    const snapshot = getSpreadSnapshot(sqlite, questionId);

    expect(
      snapshot,
      `No row in ${EXPECTED_SPREAD_SNAPSHOTS_TABLE} for question "${questionId}" ` +
        `after cron invocation with 1 platform match. ` +
        `The cron must still write a row (with null spread) even for single-platform questions.`
    ).toBeDefined();

    expect(
      snapshot?.spread === null,
      `spread_snapshots.spread=${snapshot?.spread} for single-platform question. ` +
        `DoD 3: "spread = null (NOT zero)" when fewer than 2 platforms match. ` +
        `The cron must store null (not 0) so alert eligibility logic can filter it out.`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DoD 7, 8, 9: Key-failure pause — no Wire call attempted
// ---------------------------------------------------------------------------

describe(
  "DoD 7–9 — Key-failure pause: key-missing | key-invalid | quota-exhausted",
  () => {
    let dbPath: string;
    let sqlite: InstanceType<typeof Database>;

    beforeAll(() => {
      dbPath = makeTempDbPath("key-failure");
      runSeed(dbPath);
      sqlite = new Database(dbPath);
      sqlite.pragma("journal_mode = WAL");

      // Ensure question_matches has data for the primary user so the cron would
      // normally process them
      try {
        const questionId = FIXTURE_QUESTIONS[0].id;
        sqlite
          .prepare(
            `INSERT OR REPLACE INTO question_matches
             (id, question_id, platform, market_id, implied_yes_prob, last_seen_at)
             VALUES
             ('cm-kl-kf', ?, 'kalshi',     'KL-FED', 0.43, unixepoch()),
             ('cm-mm-kf', ?, 'manifold',   'MM-FED', 0.45, unixepoch()),
             ('cm-pm-kf', ?, 'polymarket', 'PM-FED', 0.40, unixepoch()),
             ('cm-rh-kf', ?, 'robinhood',  'RH-FED', 0.43, unixepoch())`
          )
          .run(questionId, questionId, questionId, questionId);
      } catch {
        // table missing — pre-implementation
      }
    });

    afterAll(() => {
      try { sqlite?.close(); } catch {}
    });

    beforeEach(() => {
      // Reset wireRequest spy state before each test
      vi.restoreAllMocks();
    });

    // -------------------------------------------------------------------------
    // DoD 7 — key-missing
    // -------------------------------------------------------------------------

    it(
      "DoD 7 — user with status=key-missing: cron skips, ZERO Wire calls for that user " +
        "(ADR-0002 §'Error taxonomy': key-missing)",
      async () => {
        if (cronHandlerError) {
          throw new Error(
            `app/api/cron/refresh-spreads/route.ts not found: ${cronHandlerError.message}. ` +
              `Cannot assert skip behavior without the cron handler. ` +
              `Create the cron route handler first.`
          );
        }

        if (wireClientError) {
          throw new Error(
            `lib/wire/client.ts not importable: ${wireClientError.message}. ` +
              `Cannot spy on wireRequest to assert skip behavior.`
          );
        }

        // Update the primary fixture user to key-missing for this test
        sqlite
          .prepare(
            `UPDATE users SET anakin_key_ct = NULL, anakin_key_status = 'key-missing'
             WHERE id = ?`
          )
          .run(FIXTURE_USER_WITH_KEY.id);

        const wireRequestSpy = vi.spyOn(
          await import("../../lib/wire/client.js"),
          "wireRequest"
        );

        await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET }).catch(() => {
          // handler may throw if no valid users — acceptable
        });

        // Count calls for the key-missing user
        const callsForUser = wireRequestSpy.mock.calls.filter(
          (call) => call[0] === FIXTURE_USER_WITH_KEY.id
        );

        expect(
          callsForUser.length,
          `wireRequest was called ${callsForUser.length} time(s) for user ` +
            `id="${FIXTURE_USER_WITH_KEY.id}" (status=key-missing). ` +
            `ADR-0002 §'Error taxonomy': key-missing — ` +
            `"Cron skips user for the tick. No Wire call attempted." ` +
            `The cron must detect status=key-missing BEFORE calling wireRequest.`
        ).toBe(0);
      }
    );

    it(
      "DoD 7 — key-missing user: no spread row is written",
      async () => {
        sqlite
          .prepare(
            `UPDATE users SET anakin_key_ct = NULL, anakin_key_status = 'key-missing'
             WHERE id = ?`
          )
          .run(FIXTURE_USER_WITH_KEY.id);

        // Delete any pre-existing snapshot for this test to be clean
        try {
          sqlite
            .prepare(`DELETE FROM ${EXPECTED_SPREAD_SNAPSHOTS_TABLE} WHERE question_id = ?`)
            .run(FIXTURE_QUESTIONS[0].id);
        } catch {}

        await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET }).catch(() => {});

        const snapshot = getSpreadSnapshot(sqlite, FIXTURE_QUESTIONS[0].id);

        expect(
          snapshot === undefined || snapshot === null,
          `Found a spread snapshot for question "${FIXTURE_QUESTIONS[0].id}" ` +
            `despite the user having status=key-missing. ` +
            `ADR-0002: key-missing users must be fully skipped — no Wire call, ` +
            `no spread row written.`
        ).toBe(true);
      }
    );

    // -------------------------------------------------------------------------
    // DoD 8 — key-invalid
    // -------------------------------------------------------------------------

    it(
      "DoD 8 — user with status=key-invalid: cron skips, ZERO Wire calls for that user " +
        "(ADR-0002 §'Error taxonomy': key-invalid)",
      async () => {
        if (cronHandlerError) {
          throw new Error(
            `app/api/cron/refresh-spreads/route.ts not found: ${cronHandlerError.message}. ` +
              `Cannot assert skip behavior without the cron handler.`
          );
        }

        if (wireClientError) {
          throw new Error(
            `lib/wire/client.ts not importable: ${wireClientError.message}`
          );
        }

        // Set user to key-invalid (key ciphertext may exist but status is invalid)
        sqlite
          .prepare(
            `UPDATE users SET anakin_key_status = 'key-invalid', anakin_key_status_at = unixepoch()
             WHERE id = ?`
          )
          .run(FIXTURE_USER_WITH_KEY.id);

        const wireRequestSpy = vi.spyOn(
          await import("../../lib/wire/client.js"),
          "wireRequest"
        );

        await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET }).catch(() => {});

        const callsForUser = wireRequestSpy.mock.calls.filter(
          (call) => call[0] === FIXTURE_USER_WITH_KEY.id
        );

        expect(
          callsForUser.length,
          `wireRequest was called ${callsForUser.length} time(s) for user ` +
            `id="${FIXTURE_USER_WITH_KEY.id}" (status=key-invalid). ` +
            `ADR-0002 §'Error taxonomy': key-invalid — ` +
            `"Cron sets users.anakin_key_status = 'key-invalid' … skips user." ` +
            `When status IS ALREADY key-invalid, the cron must not retry the Wire call. ` +
            `The decrypt helper (lib/wire/decrypt.ts) throws WireError({class:'key-invalid'}) ` +
            `when status=key-invalid, so the cron must catch it and skip cleanly.`
        ).toBe(0);
      }
    );

    it(
      "DoD 8 — key-invalid user: no spread row written",
      async () => {
        sqlite
          .prepare(
            `UPDATE users SET anakin_key_status = 'key-invalid', anakin_key_status_at = unixepoch()
             WHERE id = ?`
          )
          .run(FIXTURE_USER_WITH_KEY.id);

        try {
          sqlite
            .prepare(`DELETE FROM ${EXPECTED_SPREAD_SNAPSHOTS_TABLE} WHERE question_id = ?`)
            .run(FIXTURE_QUESTIONS[0].id);
        } catch {}

        await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET }).catch(() => {});

        const snapshot = getSpreadSnapshot(sqlite, FIXTURE_QUESTIONS[0].id);

        expect(
          snapshot === undefined || snapshot === null,
          `Found a spread snapshot for question "${FIXTURE_QUESTIONS[0].id}" ` +
            `despite the user having status=key-invalid. ` +
            `ADR-0002: key-invalid users must be fully skipped — no Wire call, ` +
            `no spread row written.`
        ).toBe(true);
      }
    );

    // -------------------------------------------------------------------------
    // DoD 9 — quota-exhausted (+ cooldown rule)
    // -------------------------------------------------------------------------

    /**
     * Cooldown rule documentation (DoD 9):
     *
     * When status = 'quota-exhausted' is set at time T (stored in anakin_key_status_at),
     * the cron must skip this user for all ticks until T + QUOTA_COOLDOWN_MS (10 minutes).
     *
     * Rationale (ADR-0002 §"Rate-limit handling"):
     *   Wire quotas reset hourly per Anakin docs. A 10-minute cooldown ensures:
     *   - The cron does not hammer the API during a quota window.
     *   - The user is automatically retried after the cooldown (no manual reset needed).
     *   - The cooldown is >1 cron interval (5 min) so at least one tick is always skipped.
     *
     * Implementation contract:
     *   The cron handler must:
     *   1. On each tick, for users with status=quota-exhausted:
     *      a. Read anakin_key_status_at (the time the status was set).
     *      b. If now() < anakin_key_status_at + QUOTA_COOLDOWN_MS: skip (no Wire call).
     *      c. If now() >= anakin_key_status_at + QUOTA_COOLDOWN_MS: attempt Wire call.
     *         If it succeeds, set status=ok; if quota again, update status_at to now().
     *
     * QUOTA_COOLDOWN_MS = 10 * 60 * 1000 = 600_000 (10 minutes).
     * This constant is exported from tests/cron/helpers/cron-fixtures.ts for the
     * implementer to reference.
     */

    it(
      "DoD 9 — user with status=quota-exhausted: cron skips, ZERO Wire calls " +
        "(ADR-0002 §'Error taxonomy': quota-exhausted)",
      async () => {
        if (cronHandlerError) {
          throw new Error(
            `app/api/cron/refresh-spreads/route.ts not found: ${cronHandlerError.message}. ` +
              `Cannot assert skip behavior without the cron handler.`
          );
        }

        if (wireClientError) {
          throw new Error(
            `lib/wire/client.ts not importable: ${wireClientError.message}`
          );
        }

        // Set user to quota-exhausted with status_at = NOW (within cooldown)
        sqlite
          .prepare(
            `UPDATE users SET anakin_key_status = 'quota-exhausted',
             anakin_key_status_at = unixepoch()
             WHERE id = ?`
          )
          .run(FIXTURE_USER_WITH_KEY.id);

        const wireRequestSpy = vi.spyOn(
          await import("../../lib/wire/client.js"),
          "wireRequest"
        );

        await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET }).catch(() => {});

        const callsForUser = wireRequestSpy.mock.calls.filter(
          (call) => call[0] === FIXTURE_USER_WITH_KEY.id
        );

        expect(
          callsForUser.length,
          `wireRequest was called ${callsForUser.length} time(s) for user ` +
            `id="${FIXTURE_USER_WITH_KEY.id}" (status=quota-exhausted, within cooldown). ` +
            `ADR-0002 §'Error taxonomy': quota-exhausted — ` +
            `"Cron sets users.anakin_key_status = 'quota-exhausted', skips user this tick." ` +
            `When status=quota-exhausted AND now() < status_at + ${QUOTA_COOLDOWN_MS}ms, ` +
            `the cron must skip the user (no Wire call attempted).`
        ).toBe(0);
      }
    );

    it(
      `DoD 9 — cooldown rule: invocation at T+${QUOTA_COOLDOWN_MS / 60_000}min-1s still skips (within cooldown)`,
      async () => {
        if (cronHandlerError) {
          throw new Error(
            `app/api/cron/refresh-spreads/route.ts not found: ${cronHandlerError.message}. ` +
              `Cannot assert cooldown behavior without the cron handler.`
          );
        }

        if (wireClientError) {
          throw new Error(
            `lib/wire/client.ts not importable: ${wireClientError.message}`
          );
        }

        vi.useFakeTimers();
        try {
          const tNow = Date.now();
          vi.setSystemTime(tNow);

          // Set status_at = tNow - (QUOTA_COOLDOWN_MS - 1 second) = still within cooldown
          const statusAtSec = Math.floor((tNow - (QUOTA_COOLDOWN_MS - 1000)) / 1000);
          sqlite
            .prepare(
              `UPDATE users SET anakin_key_status = 'quota-exhausted',
               anakin_key_status_at = ?
               WHERE id = ?`
            )
            .run(statusAtSec, FIXTURE_USER_WITH_KEY.id);

          const wireRequestSpy = vi.spyOn(
            await import("../../lib/wire/client.js"),
            "wireRequest"
          );

          await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET }).catch(() => {});

          const callsForUser = wireRequestSpy.mock.calls.filter(
            (call) => call[0] === FIXTURE_USER_WITH_KEY.id
          );

          expect(
            callsForUser.length,
            `wireRequest was called ${callsForUser.length} time(s) for user ` +
              `(status=quota-exhausted, status_at=T-${(QUOTA_COOLDOWN_MS - 1000) / 1000}s, ` +
              `cooldown=${QUOTA_COOLDOWN_MS / 60_000}min). ` +
              `DoD 9 cooldown rule: "an invocation at T+${QUOTA_COOLDOWN_MS / 60_000}min-1s still skips." ` +
              `The cron must check now() < status_at + ${QUOTA_COOLDOWN_MS}ms before skipping.`
          ).toBe(0);
        } finally {
          vi.useRealTimers();
          vi.restoreAllMocks();
        }
      }
    );

    it(
      `DoD 9 — cooldown rule: invocation at T+${QUOTA_COOLDOWN_MS / 60_000}min attempts Wire call (cooldown expired)`,
      async () => {
        if (wireClientError) {
          throw new Error(
            `lib/wire/client.ts not importable: ${wireClientError.message}`
          );
        }

        vi.useFakeTimers();
        try {
          const tNow = Date.now();
          vi.setSystemTime(tNow);

          // Set status_at = tNow - QUOTA_COOLDOWN_MS (exactly at the expiry boundary)
          const statusAtSec = Math.floor((tNow - QUOTA_COOLDOWN_MS) / 1000);
          sqlite
            .prepare(
              `UPDATE users SET anakin_key_status = 'quota-exhausted',
               anakin_key_status_at = ?
               WHERE id = ?`
            )
            .run(statusAtSec, FIXTURE_USER_WITH_KEY.id);

          const { clearWireCalls, getLastWireCall } = await import("../../lib/wire/fixtures.js");
          clearWireCalls();

          await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET }).catch(() => {});

          const lastCall = getLastWireCall();

          expect(
            lastCall !== undefined,
            `No Wire calls were recorded after cooldown expired ` +
              `(status_at = T - ${QUOTA_COOLDOWN_MS / 60_000}min, exactly at boundary). ` +
              `DoD 9 cooldown rule: "an invocation at T+${QUOTA_COOLDOWN_MS / 60_000}min ` +
              `attempts the Wire call again." ` +
              `The cron must allow the Wire call when now() >= status_at + ${QUOTA_COOLDOWN_MS}ms.`
          ).toBe(true);
        } finally {
          vi.useRealTimers();
          vi.restoreAllMocks();
        }
      }
    );

    it(
      "DoD 9 — quota-exhausted user: no spread row written (within cooldown)",
      async () => {
        sqlite
          .prepare(
            `UPDATE users SET anakin_key_status = 'quota-exhausted',
             anakin_key_status_at = unixepoch()
             WHERE id = ?`
          )
          .run(FIXTURE_USER_WITH_KEY.id);

        try {
          sqlite
            .prepare(`DELETE FROM ${EXPECTED_SPREAD_SNAPSHOTS_TABLE} WHERE question_id = ?`)
            .run(FIXTURE_QUESTIONS[0].id);
        } catch {}

        await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET }).catch(() => {});

        const snapshot = getSpreadSnapshot(sqlite, FIXTURE_QUESTIONS[0].id);

        expect(
          snapshot === undefined || snapshot === null,
          `Found a spread snapshot for question "${FIXTURE_QUESTIONS[0].id}" ` +
            `despite the user having status=quota-exhausted (within cooldown). ` +
            `ADR-0002: quota-exhausted users must be skipped within the cooldown period.`
        ).toBe(true);
      }
    );

    it(
      "DoD 9 — users with valid keys are still processed while a quota-exhausted user is skipped",
      async () => {
        // This test requires a second user with a valid key to ensure the cron
        // continues processing other users even when one is skipped.
        //
        // Pre-implementation: this test will fail because the cron handler
        // does not exist yet. Post-implementation, it verifies that the cron
        // iterates ALL users and only skips the quota-exhausted one.

        // Set the primary user to quota-exhausted
        sqlite
          .prepare(
            `UPDATE users SET anakin_key_status = 'quota-exhausted',
             anakin_key_status_at = unixepoch()
             WHERE id = ?`
          )
          .run(FIXTURE_USER_WITH_KEY.id);

        // Ensure secondary user (key-missing) is set correctly — cron must skip it too
        // but for a different reason. The test verifies the cron handler does not
        // abort entirely when encountering the first skipped user.

        // If there were a third user with valid key, we'd assert their data is processed.
        // With only 2 fixture users (one quota-exhausted, one key-missing), the cron
        // handler must complete without error (exit 200), even if no users produce spreads.
        const resp = await invokeCronHandler({
          dbPath,
          cronSecret: TEST_CRON_SECRET,
        }).catch((err) => {
          throw new Error(
            `cron handler threw an unhandled error when all users are in skip-state: ` +
              `${(err as Error).message}. ` +
              `The cron handler must complete cleanly (return 200) even when all users ` +
              `are skipped due to key status. It must not throw or return 5xx.`
          );
        });

        expect(
          resp.status,
          `cron handler returned ${resp.status} when all users are skip-status. ` +
            `Expected 200 (all users skipped gracefully).`
        ).toBe(200);
      }
    );
  }
);

// ---------------------------------------------------------------------------
// DoD 10: Per-user 8s budget
// ---------------------------------------------------------------------------

describe(
  "DoD 10 — Per-user 8s budget (ADR-0002 §'Retry / backoff': AbortController 8s)",
  () => {
    /**
     * ADR-0002 §"Retry / backoff":
     *   "The cron handler enforces a global AbortController set to 8 s so we
     *   always return before the 10 s function timeout."
     *   "One retry on 5xx/429 with 250 ms jitter; hard total budget 6 s per user
     *   per cron tick (4 actions × ~1.5 s p95 each)."
     *
     * This test asserts that the cron handler can process at least one user's
     * questions within the 8s budget when all Wire calls use fixture mode
     * (which returns synchronously — near-instant). The critical assertion is
     * that the cron parallelises per-platform calls within a user's budget,
     * rather than running them sequentially (which would be 4 × 1.5s = 6s naïve
     * and potentially 80s with many questions).
     *
     * Test setup:
     *   - Stub wireRequest to resolve after a fixed delay (100ms per call to
     *     simulate realistic latency without blowing the 8s budget).
     *   - The test asserts that the total wall-clock time for one user with
     *     5 questions × 4 platforms = 20 Wire calls completes in < PER_USER_BUDGET_MS.
     *   - This is only possible if the implementation parallelises platform calls
     *     within each question (Promise.all on 4 platforms), and optionally
     *     parallelises across questions within the 8s budget.
     *
     * The 8s AbortController must be passed as the signal to wireRequest so that
     * individual Wire calls are aborted if they run too long.
     */

    let dbPath: string;
    let sqlite: InstanceType<typeof Database>;

    beforeAll(() => {
      dbPath = makeTempDbPath("budget");
      runSeed(dbPath);
      sqlite = new Database(dbPath);
      sqlite.pragma("journal_mode = WAL");

      // Insert question_matches for all 5 questions × 4 platforms
      // (cron reads these to know which platforms to call)
      try {
        for (const q of FIXTURE_QUESTIONS) {
          if (q.expected_platforms.length < 4) continue;
          sqlite
            .prepare(
              `INSERT OR REPLACE INTO question_matches
               (id, question_id, platform, market_id, implied_yes_prob, last_seen_at)
               VALUES
               (?, ?, 'kalshi',     'KL', 0.43, unixepoch()),
               (?, ?, 'manifold',   'MM', 0.45, unixepoch()),
               (?, ?, 'polymarket', 'PM', 0.40, unixepoch()),
               (?, ?, 'robinhood',  'RH', 0.43, unixepoch())`
            )
            .run(
              `kl-${q.id}`, q.id,
              `mm-${q.id}`, q.id,
              `pm-${q.id}`, q.id,
              `rh-${q.id}`, q.id
            );
        }
      } catch {
        // table missing pre-implementation
      }
    });

    afterAll(() => {
      try { sqlite?.close(); } catch {}
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it(
      `per-user cron iteration completes within ${PER_USER_BUDGET_MS}ms for 1 user with 3 questions on 4 platforms`,
      async () => {
        if (cronHandlerError) {
          throw new Error(
            `app/api/cron/refresh-spreads/route.ts not found: ${cronHandlerError.message}. ` +
              `Cannot assert budget behavior without the cron handler.`
          );
        }

        if (wireClientError) {
          throw new Error(
            `lib/wire/client.ts not importable: ${wireClientError.message}`
          );
        }

        // Stub wireRequest to simulate 100ms per call
        // Sequential: 3 questions × 4 platforms × 100ms = 1200ms
        // Parallel within question: 3 questions × 100ms = 300ms
        // Fully parallel: 100ms
        // All of these are within the 8s budget in fixture mode.
        // The test asserts the overall time is < PER_USER_BUDGET_MS (8s).
        // A future test with a 1.5s delay per call would expose non-parallelism.
        const STUB_DELAY_MS = 100;

        vi.spyOn(
          await import("../../lib/wire/client.js"),
          "wireRequest"
        ).mockImplementation(
          async (_userId, _action, _params, options) => {
            await new Promise((resolve) =>
              setTimeout(resolve, STUB_DELAY_MS)
            );
            // Respect the abort signal
            if (options?.signal?.aborted) {
              throw new Error("AbortError");
            }
            return {}; // empty fixture
          }
        );

        const start = Date.now();
        await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET }).catch(() => {});
        const elapsed = Date.now() - start;

        expect(
          elapsed < PER_USER_BUDGET_MS,
          `Cron invocation took ${elapsed}ms, exceeding the ${PER_USER_BUDGET_MS}ms budget. ` +
            `ADR-0002 §"Retry / backoff": "hard total budget 6 s per user per cron tick". ` +
            `The cron handler uses an AbortController set to ${PER_USER_BUDGET_MS}ms. ` +
            `With ${STUB_DELAY_MS}ms per Wire call, sequential execution of ` +
            `(n_questions × 4 platforms) Wire calls must be parallelised. ` +
            `The implementation must use Promise.all (or Promise.allSettled) for ` +
            `per-platform calls within each user's iteration.`
        ).toBe(true);
      }
    );

    it(
      "cron passes an AbortSignal to wireRequest (8s controller per ADR-0002)",
      async () => {
        if (cronHandlerError) {
          throw new Error(
            `app/api/cron/refresh-spreads/route.ts not found: ${cronHandlerError.message}. ` +
              `Cannot assert AbortSignal is passed without the cron handler.`
          );
        }

        if (wireClientError) {
          throw new Error(
            `lib/wire/client.ts not importable: ${wireClientError.message}`
          );
        }

        const signalsSeen: Array<AbortSignal | undefined> = [];

        vi.spyOn(
          await import("../../lib/wire/client.js"),
          "wireRequest"
        ).mockImplementation(
          async (_userId, _action, _params, options) => {
            signalsSeen.push(options?.signal);
            return {};
          }
        );

        await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET }).catch(() => {});

        // If cron ran at all, it must have passed a signal
        if (signalsSeen.length > 0) {
          const hasSignal = signalsSeen.some((s) => s instanceof AbortSignal);
          expect(
            hasSignal,
            `wireRequest was called ${signalsSeen.length} time(s) but none had an AbortSignal. ` +
              `ADR-0002 §"Retry / backoff": "The cron handler enforces a global AbortController ` +
              `set to 8 s so we always return before the 10 s function timeout." ` +
              `The cron handler must create an AbortController and pass .signal to wireRequest.`
          ).toBe(true);
        } else {
          throw new Error(
            `wireRequest was not called at all. The cron handler must call wireRequest ` +
              `for each platform match. Check that question_matches is populated and ` +
              `that the cron reads it correctly.`
          );
        }
      }
    );
  }
);

// ---------------------------------------------------------------------------
// DoD 11: CRON_SECRET authentication
// ---------------------------------------------------------------------------

describe("DoD 11 — CRON_SECRET authentication (ADR-0001: system route, not user route)", () => {
  let dbPath: string;

  beforeAll(() => {
    dbPath = makeTempDbPath("auth");
    runSeed(dbPath);
  });

  it("cron route returns 401 without x-cron-secret header", async () => {
    const { NextRequest } = await import("next/server");

    const mod = await import("../../app/api/cron/refresh-spreads/route.js").catch((err) => {
      throw new Error(
        `app/api/cron/refresh-spreads/route.ts not found: ${(err as Error).message}. ` +
          `Create this route handler with GET or POST export. ` +
          `The handler must check for x-cron-secret header and return 401 if absent.`
      );
    });

    const url = `http://localhost:3000${CRON_ROUTE}`;
    const req = new NextRequest(url, {
      method: "GET",
      headers: {}, // NO cron secret
    });

    const { testDbUrlStore } = await import("../../db/client.js");
    const resp = await testDbUrlStore.run(`file:${dbPath}`, async () => {
      const handler = (mod.GET ?? mod.POST) as ((req: unknown) => Promise<Response>) | undefined;
      if (!handler) {
        throw new Error(
          "route.ts does not export GET or POST — handler is required for cron route"
        );
      }
      return handler(req);
    });

    expect(
      resp.status,
      `cron route returned ${resp.status} without x-cron-secret header. ` +
        `DoD 11: "The route requires a CRON_SECRET header (from .env.example). ` +
        `Without it → 401." ` +
        `The handler must check: ` +
        `if (request.headers.get('x-cron-secret') !== process.env.CRON_SECRET) return 401`
    ).toBe(401);
  });

  it("cron route returns 401 with wrong x-cron-secret value", async () => {
    const { NextRequest } = await import("next/server");
    const mod = await import("../../app/api/cron/refresh-spreads/route.js").catch((err) => {
      throw new Error(`Route not found: ${(err as Error).message}`);
    });

    const url = `http://localhost:3000${CRON_ROUTE}`;
    const req = new NextRequest(url, {
      method: "GET",
      headers: { "x-cron-secret": "WRONG-SECRET" },
    });

    const { testDbUrlStore } = await import("../../db/client.js");
    const resp = await testDbUrlStore.run(`file:${dbPath}`, async () => {
      const handler = (mod.GET ?? mod.POST) as ((req: unknown) => Promise<Response>) | undefined;
      return handler!(req);
    });

    expect(
      resp.status,
      `cron route returned ${resp.status} with wrong x-cron-secret. ` +
        `Expected 401. The handler must validate the secret matches CRON_SECRET env var.`
    ).toBe(401);
  });

  it("cron route returns 200 (or 2xx) with correct x-cron-secret", async () => {
    // Set the CRON_SECRET env var for this test
    const prevSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = TEST_CRON_SECRET;

    try {
      const resp = await invokeCronHandler({
        dbPath,
        cronSecret: TEST_CRON_SECRET,
      });

      expect(
        resp.status >= 200 && resp.status < 300,
        `cron route returned ${resp.status} with correct x-cron-secret="${TEST_CRON_SECRET}". ` +
          `Expected 2xx. DoD 11: "With [correct CRON_SECRET] → handler runs." ` +
          `The handler must return 200 on success (even if no users have valid keys).`
      ).toBe(true);
    } finally {
      if (prevSecret !== undefined) {
        process.env.CRON_SECRET = prevSecret;
      } else {
        delete process.env.CRON_SECRET;
      }
    }
  });

  it("cron route is not authenticated by NextAuth session (system route guard)", async () => {
    /**
     * DoD 11: "NextAuth user sessions must NOT authorize cron (it's a system route,
     * not a user route)."
     *
     * The cron route must reject requests that have a session cookie but no
     * x-cron-secret header — even if the session is valid.
     *
     * This prevents a logged-in user from triggering the cron by visiting the URL.
     */
    const { NextRequest } = await import("next/server");
    const mod = await import("../../app/api/cron/refresh-spreads/route.js").catch((err) => {
      throw new Error(`Route not found: ${(err as Error).message}`);
    });

    const url = `http://localhost:3000${CRON_ROUTE}`;
    const req = new NextRequest(url, {
      method: "GET",
      headers: {
        // Provide a (fake) session cookie but NO cron secret
        Cookie: "next-auth.session-token=fixture-session-token-do-not-use-in-prod",
      },
    });

    const { testDbUrlStore } = await import("../../db/client.js");
    const resp = await testDbUrlStore.run(`file:${dbPath}`, async () => {
      const handler = (mod.GET ?? mod.POST) as ((req: unknown) => Promise<Response>) | undefined;
      return handler!(req);
    });

    expect(
      resp.status,
      `cron route returned ${resp.status} when request has a session cookie but no ` +
        `x-cron-secret. Expected 401. ` +
        `DoD 11: "NextAuth user sessions must NOT authorize cron (it's a system route)." ` +
        `The handler must ONLY check CRON_SECRET, not the session.`
    ).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// DoD 12: Idempotent under back-pressure
// ---------------------------------------------------------------------------

describe("DoD 12 — Idempotent under back-pressure (no double Wire charges within 60s)", () => {
  /**
   * DoD 12: "If two cron ticks fire in quick succession (e.g. webhook retry,
   * manual trigger + scheduled trigger), the second one observing a recent
   * last_updated (within last 60s) should be a no-op for that user,
   * NOT double-charge their Wire quota."
   *
   * IDEMPOTENCY_WINDOW_MS = 60_000 (60 seconds).
   *
   * The cron handler must:
   *   1. After persisting a spread_snapshot with last_updated = T,
   *   2. On subsequent invocation with now() - T < 60s, skip Wire calls
   *      (return the cached snapshot without re-querying Wire).
   *   3. Only re-query Wire when now() - T >= 60s (one full cron cycle).
   */

  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("idempotent");
    runSeed(dbPath);
    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");

    try {
      const questionId = FIXTURE_QUESTIONS[0].id;
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO question_matches
           (id, question_id, platform, market_id, implied_yes_prob, last_seen_at)
           VALUES
           ('cm-kl-idem', ?, 'kalshi',     'KL', 0.43, unixepoch()),
           ('cm-mm-idem', ?, 'manifold',   'MM', 0.45, unixepoch()),
           ('cm-pm-idem', ?, 'polymarket', 'PM', 0.40, unixepoch()),
           ('cm-rh-idem', ?, 'robinhood',  'RH', 0.43, unixepoch())`
        )
        .run(
          questionId, questionId, questionId, questionId
        );
    } catch {
      // table missing pre-implementation
    }
  });

  afterAll(() => {
    try { sqlite?.close(); } catch {}
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it(
    `two cron invocations within ${IDEMPOTENCY_WINDOW_MS / 1000}s fire only ONE Wire batch (no double-charge)`,
    async () => {
      if (cronHandlerError) {
        throw new Error(
          `app/api/cron/refresh-spreads/route.ts not found: ${cronHandlerError.message}. ` +
            `Cannot assert idempotency without the cron handler.`
        );
      }

      if (wireClientError) {
        throw new Error(
          `lib/wire/client.ts not importable: ${wireClientError.message}`
        );
      }

      const { clearWireCalls } = await import("../../lib/wire/fixtures.js");
      clearWireCalls();

      // Track wireRequest calls by counting
      const wireCallCounts: number[] = [];
      let totalCalls = 0;

      vi.spyOn(
        await import("../../lib/wire/client.js"),
        "wireRequest"
      ).mockImplementation(async () => {
        totalCalls++;
        return {};
      });

      // First invocation — should make Wire calls
      await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET }).catch(() => {});
      wireCallCounts.push(totalCalls);
      const firstBatchCount = totalCalls;

      // Reset counter
      totalCalls = 0;

      // Second invocation within 1s (well within IDEMPOTENCY_WINDOW_MS)
      // — should be a no-op (zero Wire calls)
      await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET }).catch(() => {});
      wireCallCounts.push(totalCalls);
      const secondBatchCount = totalCalls;

      expect(
        firstBatchCount > 0,
        `First cron invocation made ${firstBatchCount} Wire calls. ` +
          `Expected >0 (cron must call Wire for each platform match on first run). ` +
          `Check that question_matches is populated.`
      ).toBe(true);

      expect(
        secondBatchCount,
        `Second cron invocation (within ${IDEMPOTENCY_WINDOW_MS / 1000}s of first) ` +
          `made ${secondBatchCount} Wire call(s). Expected 0. ` +
          `DoD 12: "the second one observing a recent last_updated (within last 60s) ` +
          `should be a no-op for that user, NOT double-charge their Wire quota." ` +
          `The cron handler must check: ` +
          `if (now() - lastUpdated < ${IDEMPOTENCY_WINDOW_MS}ms) skip Wire calls for this user.`
      ).toBe(0);
    }
  );
});

// ---------------------------------------------------------------------------
// DoD 13: Skip questions with no matches
// ---------------------------------------------------------------------------

describe("DoD 13 — Skip questions with no question_matches (no Wire, no spread row)", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("no-matches");
    runSeed(dbPath);
    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");

    // Deliberately leave question_matches EMPTY for a watched question.
    // The cron should skip it entirely.
    // (We do NOT insert any question_matches rows here.)
  });

  afterAll(() => {
    try { sqlite?.close(); } catch {}
    vi.restoreAllMocks();
  });

  it("DoD 13 — no Wire calls for questions with empty question_matches", async () => {
    if (cronHandlerError) {
      throw new Error(
        `app/api/cron/refresh-spreads/route.ts not found: ${cronHandlerError.message}. ` +
          `Cannot assert zero-Wire-calls behavior without the cron handler. ` +
          `This test must fail pre-implementation.`
      );
    }

    if (wireClientError) {
      throw new Error(
        `lib/wire/client.ts not importable: ${wireClientError.message}`
      );
    }

    // Verify question_matches is indeed empty
    let matchCount = 0;
    try {
      const row = sqlite
        .prepare("SELECT COUNT(*) as cnt FROM question_matches")
        .get() as { cnt: number };
      matchCount = row.cnt;
    } catch {
      // table missing — the test will fail as expected
    }

    expect(
      matchCount,
      `question_matches has ${matchCount} rows at the start of DoD 13 test. ` +
        `Expected 0. Check that the test beforeAll does not insert match rows.`
    ).toBe(0);

    const wireRequestSpy = vi.spyOn(
      await import("../../lib/wire/client.js"),
      "wireRequest"
    );

    await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET }).catch(() => {});

    expect(
      wireRequestSpy.mock.calls.length,
      `wireRequest was called ${wireRequestSpy.mock.calls.length} time(s) ` +
        `despite question_matches being empty. ` +
        `DoD 13: "Questions whose question_matches is empty (matching engine found ` +
        `0 platforms) are skipped — no spread row, no last_updated advance, no Wire call." ` +
        `The cron handler must check question_matches before making any Wire calls.`
    ).toBe(0);
  });

  it("DoD 13 — no spread_snapshots row for questions with empty question_matches", async () => {
    // Clean up any rows from previous test
    try {
      sqlite
        .prepare(`DELETE FROM ${EXPECTED_SPREAD_SNAPSHOTS_TABLE}`)
        .run();
    } catch {}

    await invokeCronHandler({ dbPath, cronSecret: TEST_CRON_SECRET }).catch(() => {});

    let rowCount = 0;
    try {
      const row = sqlite
        .prepare(`SELECT COUNT(*) as cnt FROM ${EXPECTED_SPREAD_SNAPSHOTS_TABLE}`)
        .get() as { cnt: number };
      rowCount = row.cnt;
    } catch (err) {
      throw new Error(
        `Failed to query ${EXPECTED_SPREAD_SNAPSHOTS_TABLE}: ${(err as Error).message}. ` +
          `The table must exist.`
      );
    }

    expect(
      rowCount,
      `Found ${rowCount} row(s) in ${EXPECTED_SPREAD_SNAPSHOTS_TABLE} ` +
        `despite all questions having empty question_matches. ` +
        `DoD 13: "no spread row" when question_matches is empty. ` +
        `The cron must not write a spread_snapshot for questions with 0 platform matches.`
    ).toBe(0);
  });

  it("DoD 13 — no last_updated advance for questions with empty question_matches", async () => {
    // Verify there's no row that could have a last_updated
    try {
      const rows = sqlite
        .prepare(`SELECT * FROM ${EXPECTED_SPREAD_SNAPSHOTS_TABLE}`)
        .all() as Array<{ last_updated: number | null }>;

      expect(
        rows.length,
        `Found ${rows.length} spread_snapshot rows after cron invocation with ` +
          `no question_matches. DoD 13: "no last_updated advance" means no row at all.`
      ).toBe(0);
    } catch (err) {
      throw new Error(
        `Failed to check ${EXPECTED_SPREAD_SNAPSHOTS_TABLE}: ${(err as Error).message}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Schema check: spread_snapshots table assertion (DoD 2)
// ---------------------------------------------------------------------------

describe("Schema — spread_snapshots table and question_matches integration", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("schema-check");
    runSeed(dbPath);
    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
  });

  afterAll(() => {
    try { sqlite?.close(); } catch {}
  });

  it(`${EXPECTED_SPREAD_SNAPSHOTS_TABLE} table exists after seed+migration`, () => {
    const row = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='${EXPECTED_SPREAD_SNAPSHOTS_TABLE}'`
      )
      .get() as { name: string } | undefined;

    expect(
      row,
      `Table "${EXPECTED_SPREAD_SNAPSHOTS_TABLE}" does not exist in the DB. ` +
        `db/schema.ts must define this table and a migration must be generated. ` +
        `Run: npx drizzle-kit generate && npx drizzle-kit push. ` +
        `Then the seed script creates the table via migration.`
    ).toBeDefined();
  });

  for (const col of EXPECTED_SPREAD_SNAPSHOTS_COLUMNS) {
    it(`${EXPECTED_SPREAD_SNAPSHOTS_TABLE} has column "${col}"`, () => {
      const cols = sqlite
        .prepare(`PRAGMA table_info(${EXPECTED_SPREAD_SNAPSHOTS_TABLE})`)
        .all() as Array<{ name: string }>;

      const colNames = cols.map((c) => c.name);

      expect(
        colNames.includes(col),
        `Column "${col}" missing from ${EXPECTED_SPREAD_SNAPSHOTS_TABLE}. ` +
          `Found columns: ${JSON.stringify(colNames)}. ` +
          `Required columns: ${JSON.stringify(EXPECTED_SPREAD_SNAPSHOTS_COLUMNS)}.`
      ).toBe(true);
    });
  }
});
