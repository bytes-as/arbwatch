/**
 * tests/thresholds/thresholds.test.ts
 *
 * Mode 1 (pre-implementation) — ALL 9 tests in this file MUST FAIL until:
 *   - db/schema.ts watched_questions table gains a `threshold real` nullable column
 *   - PATCH /api/watched/:id validates threshold (0.005 ≤ value ≤ 0.10) and stores it
 *   - lib/alerts.ts dispatchAlerts() reads the per-question threshold from the DB,
 *     falling back to SPREAD_THRESHOLD (0.03) when the column is null
 *
 * DoD items covered:
 *   TH1 — Schema: watched_questions.threshold real nullable column is present
 *   TH2 — Validation: PATCH with out-of-range threshold → 400; in-range → 200
 *   TH3 — Default fallback: null threshold fires at spread=0.04 (>= 0.03), silent at 0.025
 *   TH4 — Higher per-question threshold suppresses default-fire: threshold=0.05 at spread=0.04 → NO alert
 *   TH5 — Lower per-question threshold fires: threshold=0.02 at spread=0.025 → alert fires
 *   TH6 — Hysteresis honors per-question threshold (armed→fired→armed→fired cycle)
 *   TH7 — Phase-1 regression: null-threshold questions still use SPREAD_THRESHOLD=0.03
 *   TH8 — Cron uses live threshold per tick: mutating threshold between ticks reflects immediately
 *   TH9 — Bulk: question A (threshold=0.02, spread=0.03) fires; question B (null, spread=0.03) fires
 *          (both fire because 0.03 >= 0.03 under the >= convention inherited from Phase 1)
 *
 * Boundary convention: Phase-1 uses `>=` (inclusive), established by lib/alerts.ts line 113:
 *   `const aboveThreshold = spread >= SPREAD_THRESHOLD;`
 *   The per-question threshold must use the same convention:
 *   `const effectiveThreshold = question.threshold ?? SPREAD_THRESHOLD;`
 *   `const aboveThreshold = spread >= effectiveThreshold;`
 *
 * Architecture references:
 *   lib/alerts.ts — SPREAD_THRESHOLD = 0.03, processQuestion(), dispatchAlerts()
 *   db/schema.ts  — watched_questions table
 *   app/api/watched/[id]/route.ts — must gain a PATCH handler
 *   tests/cron/helpers/cron-fixtures.ts — fixture user/questions/constants
 *   tests/auth/__mocks__/resend.ts — in-memory Resend mock (getInbox, clearInbox)
 *
 * Test approach:
 *   - vi.mock("resend") replaces Resend with the in-memory mock
 *   - Each test uses a temp SQLite DB seeded via scripts/seed.ts (same pattern as alerts tests)
 *   - Alert dispatch invoked directly via lib/alerts.ts dispatchAlerts()
 *   - DB introspection via better-sqlite3 PRAGMA table_info
 *   - PATCH requests routed in-process via fetch to http://localhost:3000
 *     (watched-server-setup.ts must dispatch PATCH requests; until it does the TH2 test
 *      will fail with 404/405 — which is the correct Mode 1 failure)
 */

import {
  describe,
  it,
  expect,
  vi,
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
  clearInbox,
  getInbox,
} from "../auth/__mocks__/resend";

import {
  REPO_ROOT,
  TEST_APP_ENCRYPTION_KEY,
  FIXTURE_USER_WITH_KEY,
  FIXTURE_QUESTIONS,
  TEST_CRON_SECRET,
} from "../cron/helpers/cron-fixtures";

// ---------------------------------------------------------------------------
// Resend mock — must be declared before any module that imports "resend" loads
// ---------------------------------------------------------------------------

vi.mock("resend");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";

/**
 * Phase-1 default threshold (falls back when question.threshold is null).
 * Must equal SPREAD_THRESHOLD exported from lib/alerts.ts.
 */
const DEFAULT_SPREAD_THRESHOLD = 0.03;

// Fixture question used for most per-question threshold tests
const THRESHOLD_QUESTION_A = FIXTURE_QUESTIONS[0]; // Fed cuts rates June 2026
const THRESHOLD_QUESTION_B = FIXTURE_QUESTIONS[1]; // Presidential election 2028 winner

// ---------------------------------------------------------------------------
// Temp DB helpers (mirrors the pattern from tests/alerts/alerts.test.ts)
// ---------------------------------------------------------------------------

const SEED_SCRIPT = join(REPO_ROOT, "scripts", "seed.ts");

function makeTempDbPath(suffix: string): string {
  const dir = join(tmpdir(), "predmkt-arb-threshold-tests");
  mkdirSync(dir, { recursive: true });
  return join(dir, `threshold-${suffix}-${process.pid}.db`);
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

function seedSpreadSnapshot(
  sqlite: InstanceType<typeof Database>,
  questionId: string,
  spread: number | null,
  nowMs: number
): void {
  const nowSec = Math.floor(nowMs / 1000);
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO spread_snapshots (id, question_id, spread, last_updated, computed_at)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)`
    )
    .run(questionId, spread, nowSec, nowSec);
}

function seedQuestionMatches(
  sqlite: InstanceType<typeof Database>,
  questionId: string
): void {
  const platforms = ["kalshi", "manifold", "polymarket", "robinhood"] as const;
  for (const platform of platforms) {
    sqlite
      .prepare(
        `INSERT OR REPLACE INTO question_matches
           (id, question_id, platform, market_id, market_url, implied_yes_prob, last_seen_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, unixepoch())`
      )
      .run(
        questionId,
        platform,
        `${platform}-market-id`,
        `https://${platform}.com/markets/${questionId}`,
        0.43
      );
  }
}

/**
 * Set the per-question threshold directly in the DB.
 * This simulates what PATCH /api/watched/:id must do once implemented.
 * Fails pre-implementation if the column doesn't exist — causing TH1 to fail.
 */
function setQuestionThreshold(
  sqlite: InstanceType<typeof Database>,
  questionId: string,
  threshold: number | null
): void {
  sqlite
    .prepare(`UPDATE watched_questions SET threshold = ? WHERE id = ?`)
    .run(threshold, questionId);
}

function getAlertRow(
  sqlite: InstanceType<typeof Database>,
  questionId: string
):
  | {
      state: string;
      last_alerted_at: number | null;
      last_alerted_spread: number | null;
    }
  | undefined {
  return sqlite
    .prepare(
      `SELECT state, last_alerted_at, last_alerted_spread
       FROM alerts
       WHERE question_id = ?`
    )
    .get(questionId) as
    | {
        state: string;
        last_alerted_at: number | null;
        last_alerted_spread: number | null;
      }
    | undefined;
}

// ---------------------------------------------------------------------------
// Optional import of dispatchAlerts — fails gracefully pre-implementation
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dispatchAlerts: ((dbPath: string, nowMs: number) => Promise<void>) | null = null;
let alertsLibError: Error | null = null;

try {
  const mod = await import("../../lib/alerts.js");
  dispatchAlerts = mod.dispatchAlerts;
} catch (err) {
  alertsLibError = err as Error;
}

let SPREAD_THRESHOLD: number | undefined;
try {
  const mod = await import("../../lib/alerts.js");
  SPREAD_THRESHOLD = mod.SPREAD_THRESHOLD;
} catch {
  // already captured
}

async function invokeAlertDispatch(dbPath: string, nowMs: number): Promise<void> {
  if (alertsLibError || !dispatchAlerts) {
    throw new Error(
      `lib/alerts.ts does not exist or fails to import. ` +
        `dispatchAlerts must be exported and accept (dbPath: string, nowMs: number). ` +
        `Original import error: ${alertsLibError?.message ?? "dispatchAlerts not exported"}`
    );
  }
  return dispatchAlerts(dbPath, nowMs);
}

// ---------------------------------------------------------------------------
// TH1 — Schema column: watched_questions.threshold real nullable
// ---------------------------------------------------------------------------

describe("TH1 — Schema: watched_questions has a nullable `threshold` real column", () => {
  it("watched_questions.threshold column exists, is REAL type, and is nullable", () => {
    const dbPath = makeTempDbPath("th1-schema");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");

    try {
      const columns = sqlite
        .prepare(`PRAGMA table_info(watched_questions)`)
        .all() as Array<{
          cid: number;
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }>;

      const thresholdCol = columns.find(
        (c) => c.name.toLowerCase() === "threshold"
      );

      expect(
        thresholdCol,
        `watched_questions table has no "threshold" column. ` +
          `db/schema.ts must add: threshold: real("threshold") ` +
          `(nullable, no .notNull()) to the watchedQuestions table definition. ` +
          `Current columns: ${columns.map((c) => c.name).join(", ")}`
      ).toBeDefined();

      expect(
        thresholdCol!.type.toUpperCase(),
        `watched_questions.threshold column type is "${thresholdCol!.type}", expected "REAL". ` +
          `The threshold stores a decimal probability offset (0.005–0.10). ` +
          `Use real("threshold") in the Drizzle schema.`
      ).toBe("REAL");

      expect(
        thresholdCol!.notnull,
        `watched_questions.threshold column has NOT NULL constraint (notnull=${thresholdCol!.notnull}). ` +
          `The column must be nullable so that null signals "use the global SPREAD_THRESHOLD default". ` +
          `Remove .notNull() from the Drizzle column definition.`
      ).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("threshold defaults to null for existing rows (no data migration needed)", () => {
    const dbPath = makeTempDbPath("th1-default");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");

    try {
      const row = sqlite
        .prepare(
          `SELECT threshold FROM watched_questions WHERE id = ? LIMIT 1`
        )
        .get(THRESHOLD_QUESTION_A.id) as { threshold: number | null } | undefined;

      expect(
        row,
        `watched_questions row for id="${THRESHOLD_QUESTION_A.id}" not found. ` +
          `Ensure the seed inserts this question.`
      ).toBeDefined();

      expect(
        row!.threshold,
        `watched_questions.threshold is "${row!.threshold}" for a freshly-seeded row. ` +
          `Expected null — new rows must default to null (no per-question override).`
      ).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});

// ---------------------------------------------------------------------------
// TH2 — Validation: PATCH /api/watched/:id threshold range check
// ---------------------------------------------------------------------------

describe("TH2 — PATCH /api/watched/:id validates threshold range (0.005–0.10)", () => {
  /**
   * TH2 requires the watched-server-setup.ts to route PATCH requests to a
   * PATCH handler in app/api/watched/[id]/route.ts. Pre-implementation this
   * will return 404 (handler missing) or 405 (method not allowed) — both
   * cause these tests to fail, which is the correct Mode 1 behaviour.
   */

  it("PATCH with threshold below 0.005 returns 400", async () => {
    const id = FIXTURE_QUESTIONS[0].id;
    const res = await fetch(`${BASE_URL}/api/watched/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        // watched-server-setup reads any session token, but we need a valid one
        // The fixture session token is set by the workspace setup file (cron project)
        // For the thresholds project (runs under "alerts" or "other"), we send the
        // test session token from the cron-fixtures constants
        Cookie: `next-auth.session-token=fixture-session-token-do-not-use-in-prod`,
      },
      body: JSON.stringify({ threshold: 0.001 }),
    });

    expect(
      res.status,
      `PATCH /api/watched/${id} with threshold=0.001 (below minimum 0.005) ` +
        `returned ${res.status}. Expected 400. ` +
        `The PATCH handler must validate: 0.005 ≤ threshold ≤ 0.10. ` +
        `Values below 0.005 (0.5%) are too sensitive and would cause alert spam. ` +
        `app/api/watched/[id]/route.ts must implement a PATCH handler with this validation.`
    ).toBe(400);
  });

  it("PATCH with threshold above 0.10 returns 400", async () => {
    const id = FIXTURE_QUESTIONS[0].id;
    const res = await fetch(`${BASE_URL}/api/watched/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `next-auth.session-token=fixture-session-token-do-not-use-in-prod`,
      },
      body: JSON.stringify({ threshold: 0.15 }),
    });

    expect(
      res.status,
      `PATCH /api/watched/${id} with threshold=0.15 (above maximum 0.10) ` +
        `returned ${res.status}. Expected 400. ` +
        `The PATCH handler must validate: 0.005 ≤ threshold ≤ 0.10. ` +
        `Values above 0.10 (10%) would suppress most real-world alerts permanently.`
    ).toBe(400);
  });

  it("PATCH with threshold=0.05 (in-range) returns 200", async () => {
    const id = FIXTURE_QUESTIONS[0].id;
    const res = await fetch(`${BASE_URL}/api/watched/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `next-auth.session-token=fixture-session-token-do-not-use-in-prod`,
      },
      body: JSON.stringify({ threshold: 0.05 }),
    });

    expect(
      res.status,
      `PATCH /api/watched/${id} with threshold=0.05 (in-range 0.005–0.10) ` +
        `returned ${res.status}. Expected 200. ` +
        `A valid threshold must be accepted and persisted to watched_questions.threshold.`
    ).toBe(200);
  });

  it("PATCH with threshold=null clears the override (returns to default)", async () => {
    const id = FIXTURE_QUESTIONS[0].id;
    const res = await fetch(`${BASE_URL}/api/watched/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `next-auth.session-token=fixture-session-token-do-not-use-in-prod`,
      },
      body: JSON.stringify({ threshold: null }),
    });

    expect(
      res.status,
      `PATCH /api/watched/${id} with threshold=null returned ${res.status}. Expected 200. ` +
        `Setting threshold to null clears the per-question override and ` +
        `restores the SPREAD_THRESHOLD (0.03) fallback behavior.`
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// TH3 — Default fallback: null threshold uses SPREAD_THRESHOLD (0.03)
// ---------------------------------------------------------------------------

describe("TH3 — Default fallback: null threshold uses SPREAD_THRESHOLD=0.03", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("th3");
    runSeed(dbPath);
    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    seedQuestionMatches(sqlite, THRESHOLD_QUESTION_A.id);

    // Ensure threshold is null (the default after seed)
    // This will throw if the column does not exist yet — correct Mode 1 failure
    setQuestionThreshold(sqlite, THRESHOLD_QUESTION_A.id, null);
  });

  afterAll(() => {
    sqlite.close();
  });

  beforeEach(() => {
    clearInbox();
  });

  it("spread=0.04 (above default 0.03) fires an alert when threshold=null", async () => {
    const nowMs = Date.now();
    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_A.id, 0.04, nowMs);

    await invokeAlertDispatch(dbPath, nowMs);

    expect(
      getInbox().length,
      `Expected 1 alert for spread=0.04 when threshold=null (falls back to SPREAD_THRESHOLD=0.03). ` +
        `Got ${getInbox().length}. ` +
        `lib/alerts.ts must read question.threshold from the DB and, when null, ` +
        `fall back to the SPREAD_THRESHOLD constant (0.03). ` +
        `0.04 >= 0.03 → alert must fire.`
    ).toBe(1);
  });

  it("spread=0.025 (below default 0.03) does NOT fire when threshold=null", async () => {
    const nowMs = Date.now();
    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_A.id, 0.025, nowMs);

    await invokeAlertDispatch(dbPath, nowMs);

    expect(
      getInbox().length,
      `Expected 0 alerts for spread=0.025 when threshold=null (falls back to SPREAD_THRESHOLD=0.03). ` +
        `Got ${getInbox().length}. ` +
        `0.025 < 0.03 — alert must NOT fire under the default threshold.`
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TH4 — Higher per-question threshold suppresses default-fire
// ---------------------------------------------------------------------------

describe("TH4 — Higher per-question threshold (0.05) suppresses alert at spread=0.04", () => {
  it("threshold=0.05: spread=0.04 does NOT fire (would have fired under default 0.03)", async () => {
    const dbPath = makeTempDbPath("th4");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    seedQuestionMatches(sqlite, THRESHOLD_QUESTION_A.id);

    // Set a higher per-question threshold: alert only above 5%
    // Throws pre-implementation if the column doesn't exist — correct failure
    setQuestionThreshold(sqlite, THRESHOLD_QUESTION_A.id, 0.05);

    clearInbox();
    const nowMs = Date.now();
    // spread=0.04 is above the 3% default but BELOW the 5% override
    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_A.id, 0.04, nowMs);

    await invokeAlertDispatch(dbPath, nowMs);

    sqlite.close();

    expect(
      getInbox().length,
      `Expected 0 alerts for spread=0.04 when threshold=0.05. ` +
        `Got ${getInbox().length}. ` +
        `0.04 < 0.05 — the per-question threshold must override the SPREAD_THRESHOLD default. ` +
        `lib/alerts.ts must read watched_questions.threshold from the DB for each question and ` +
        `use it instead of SPREAD_THRESHOLD when it is not null.`
    ).toBe(0);
  });

  it("threshold=0.05: spread=0.06 DOES fire (above the per-question threshold)", async () => {
    const dbPath = makeTempDbPath("th4-fires");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    seedQuestionMatches(sqlite, THRESHOLD_QUESTION_A.id);
    setQuestionThreshold(sqlite, THRESHOLD_QUESTION_A.id, 0.05);

    clearInbox();
    const nowMs = Date.now();
    // spread=0.06 is above the 5% per-question threshold
    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_A.id, 0.06, nowMs);

    await invokeAlertDispatch(dbPath, nowMs);

    sqlite.close();

    expect(
      getInbox().length,
      `Expected 1 alert for spread=0.06 when threshold=0.05. ` +
        `Got ${getInbox().length}. ` +
        `0.06 >= 0.05 — the per-question threshold must trigger the alert when crossed.`
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TH5 — Lower per-question threshold fires at a spread that wouldn't trigger default
// ---------------------------------------------------------------------------

describe("TH5 — Lower per-question threshold (0.02) fires at spread=0.025", () => {
  it("threshold=0.02: spread=0.025 fires an alert (would NOT fire under default 0.03)", async () => {
    const dbPath = makeTempDbPath("th5");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    seedQuestionMatches(sqlite, THRESHOLD_QUESTION_A.id);

    // Set a lower per-question threshold: alert at 2%
    setQuestionThreshold(sqlite, THRESHOLD_QUESTION_A.id, 0.02);

    clearInbox();
    const nowMs = Date.now();
    // spread=0.025 is ABOVE 0.02 but BELOW the default 0.03
    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_A.id, 0.025, nowMs);

    await invokeAlertDispatch(dbPath, nowMs);

    sqlite.close();

    expect(
      getInbox().length,
      `Expected 1 alert for spread=0.025 when threshold=0.02. ` +
        `Got ${getInbox().length}. ` +
        `0.025 >= 0.02 — the per-question threshold must trigger an alert below the 3% default. ` +
        `lib/alerts.ts must use the effective threshold: ` +
        `effectiveThreshold = question.threshold ?? SPREAD_THRESHOLD`
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TH6 — Hysteresis honors per-question threshold
// ---------------------------------------------------------------------------

describe("TH6 — Hysteresis cycle uses per-question threshold for both fire and re-arm boundaries", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("th6");
    runSeed(dbPath);
    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    seedQuestionMatches(sqlite, THRESHOLD_QUESTION_A.id);

    // Set per-question threshold = 0.05 for the hysteresis test
    setQuestionThreshold(sqlite, THRESHOLD_QUESTION_A.id, 0.05);
  });

  afterAll(() => {
    sqlite.close();
  });

  beforeEach(() => {
    clearInbox();
  });

  it("full hysteresis cycle with threshold=0.05: armed→fired→armed→fired", async () => {
    const t0 = Date.now();

    // Step 1: spread=0.06 (above threshold=0.05) → fires
    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_A.id, 0.06, t0);
    await invokeAlertDispatch(dbPath, t0);

    expect(
      getInbox().length,
      `Step 1: Expected 1 alert for spread=0.06 with threshold=0.05. Got ${getInbox().length}.`
    ).toBe(1);

    const stateAfterFire = getAlertRow(sqlite, THRESHOLD_QUESTION_A.id)?.state;
    expect(
      stateAfterFire,
      `After firing at spread=0.06, state should be "fired". Got: "${stateAfterFire}".`
    ).toBe("fired");

    // Step 2: spread=0.04 (below threshold=0.05) → re-arms
    // NOTE: 0.04 would fire under the DEFAULT (0.03), but must NOT fire when
    // the per-question threshold=0.05 is active. This confirms hysteresis
    // uses the per-question threshold, not SPREAD_THRESHOLD.
    const t1 = t0 + 5 * 60_000;
    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_A.id, 0.04, t1);
    await invokeAlertDispatch(dbPath, t1);

    const stateAfterRearm = getAlertRow(sqlite, THRESHOLD_QUESTION_A.id)?.state;
    expect(
      stateAfterRearm,
      `After spread drops to 0.04 (below threshold=0.05), state should be "armed". ` +
        `Got: "${stateAfterRearm}". ` +
        `lib/alerts.ts must use the per-question threshold for the re-arm decision ` +
        `(spread < effectiveThreshold → arm), not the global SPREAD_THRESHOLD.`
    ).toBe("armed");

    // No new email should have been sent (drop below threshold)
    expect(
      getInbox().length,
      `No new email expected when spread drops to 0.04 (below threshold=0.05). ` +
        `Got ${getInbox().length} emails.`
    ).toBe(1); // still just the 1 from step 1

    // Step 3: spread=0.06 again (above threshold=0.05) → re-fires
    const t2 = t1 + 5 * 60_000;
    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_A.id, 0.06, t2);
    await invokeAlertDispatch(dbPath, t2);

    expect(
      getInbox().length,
      `After re-arming and spread re-crossing 0.05 threshold (spread=0.06), ` +
        `expected 2 total emails. Got ${getInbox().length}. ` +
        `The state machine must fire again when state=armed and spread >= effectiveThreshold.`
    ).toBe(2);

    const stateAfterRefire = getAlertRow(sqlite, THRESHOLD_QUESTION_A.id)?.state;
    expect(
      stateAfterRefire,
      `After re-firing at spread=0.06, state should be "fired" again. Got: "${stateAfterRefire}".`
    ).toBe("fired");
  });
});

// ---------------------------------------------------------------------------
// TH7 — Phase-1 regression: null threshold falls back to SPREAD_THRESHOLD=0.03
// ---------------------------------------------------------------------------

describe("TH7 — Phase-1 regression: null-threshold questions unchanged by threshold feature", () => {
  /**
   * This test re-runs a subset of the Phase-1 scenarios to confirm that
   * adding the per-question threshold column does NOT change behavior for
   * questions that have threshold=null (i.e., all existing Phase-1 questions).
   */

  it("null-threshold question fires at spread=0.031 (just above default 3%)", async () => {
    const dbPath = makeTempDbPath("th7-above");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    seedQuestionMatches(sqlite, THRESHOLD_QUESTION_A.id);

    // Explicitly null — confirms the column exists and is readable
    setQuestionThreshold(sqlite, THRESHOLD_QUESTION_A.id, null);

    clearInbox();
    const nowMs = Date.now();
    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_A.id, 0.031, nowMs);

    await invokeAlertDispatch(dbPath, nowMs);

    sqlite.close();

    expect(
      getInbox().length,
      `Expected 1 alert for spread=0.031 with threshold=null (uses default 0.03). ` +
        `Got ${getInbox().length}. ` +
        `Phase-1 regression: dispatchAlerts must behave identically when threshold is null. ` +
        `0.031 >= 0.03 → alert fires.`
    ).toBe(1);
  });

  it("null-threshold question does NOT fire at spread=0.029 (just below default 3%)", async () => {
    const dbPath = makeTempDbPath("th7-below");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    seedQuestionMatches(sqlite, THRESHOLD_QUESTION_A.id);

    setQuestionThreshold(sqlite, THRESHOLD_QUESTION_A.id, null);

    clearInbox();
    const nowMs = Date.now();
    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_A.id, 0.029, nowMs);

    await invokeAlertDispatch(dbPath, nowMs);

    sqlite.close();

    expect(
      getInbox().length,
      `Expected 0 alerts for spread=0.029 with threshold=null (uses default 0.03). ` +
        `Got ${getInbox().length}. ` +
        `0.029 < 0.03 → alert must NOT fire.`
    ).toBe(0);
  });

  it("null-threshold question fires at spread=0.03 exactly (>= is inclusive — Phase-1 convention)", async () => {
    const dbPath = makeTempDbPath("th7-exact");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    seedQuestionMatches(sqlite, THRESHOLD_QUESTION_A.id);

    setQuestionThreshold(sqlite, THRESHOLD_QUESTION_A.id, null);

    clearInbox();
    const nowMs = Date.now();
    // spread == threshold exactly: Phase-1 convention is >= (inclusive), so this fires
    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_A.id, DEFAULT_SPREAD_THRESHOLD, nowMs);

    await invokeAlertDispatch(dbPath, nowMs);

    sqlite.close();

    expect(
      getInbox().length,
      `Expected 1 alert for spread=0.03 with threshold=null (SPREAD_THRESHOLD=0.03). ` +
        `Got ${getInbox().length}. ` +
        `Phase-1 boundary convention: >= (inclusive). spread=0.03 === threshold → fires. ` +
        `lib/alerts.ts line 113: \`const aboveThreshold = spread >= SPREAD_THRESHOLD;\` ` +
        `The per-question path must use the SAME inclusive convention.`
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TH8 — Cron uses live threshold per tick (mutation between ticks reflects immediately)
// ---------------------------------------------------------------------------

describe("TH8 — Live threshold: mutating threshold between ticks immediately affects next tick", () => {
  it("changing threshold=null→0.05 between ticks suppresses alert that would have fired under default", async () => {
    const dbPath = makeTempDbPath("th8");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    seedQuestionMatches(sqlite, THRESHOLD_QUESTION_A.id);

    // Tick 1: threshold=null (default 0.03), spread=0.04 → fires
    setQuestionThreshold(sqlite, THRESHOLD_QUESTION_A.id, null);
    clearInbox();

    const t0 = Date.now();
    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_A.id, 0.04, t0);
    await invokeAlertDispatch(dbPath, t0);

    expect(
      getInbox().length,
      `Tick 1 (threshold=null, spread=0.04): expected 1 alert. Got ${getInbox().length}.`
    ).toBe(1);

    // Simulate spread dropping (re-arms hysteresis)
    const t1 = t0 + 5 * 60_000;
    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_A.id, 0.01, t1);
    await invokeAlertDispatch(dbPath, t1);

    // Mutate threshold to 0.05 BETWEEN ticks — simulates user raising their threshold
    setQuestionThreshold(sqlite, THRESHOLD_QUESTION_A.id, 0.05);

    // Tick 3: threshold is now 0.05, spread=0.04 — must NOT fire (below 0.05)
    const t2 = t1 + 5 * 60_000;
    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_A.id, 0.04, t2);
    await invokeAlertDispatch(dbPath, t2);

    sqlite.close();

    expect(
      getInbox().length,
      `After mutating threshold from null→0.05 between ticks, ` +
        `expected inbox count to remain at 1 (tick 3 with spread=0.04 should be suppressed). ` +
        `Got ${getInbox().length}. ` +
        `lib/alerts.ts must read the threshold from the DB on each invocation (not cache it) ` +
        `so threshold mutations take effect on the very next dispatchAlerts() call.`
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TH9 — Bulk: two questions, different thresholds, one tick
// ---------------------------------------------------------------------------

describe("TH9 — Bulk: two questions with different thresholds in one tick", () => {
  it("question A (threshold=0.02, spread=0.03) fires; question B (null, spread=0.03) also fires", async () => {
    /**
     * Phase-1 boundary convention: >= (inclusive).
     * - Question A: effectiveThreshold=0.02, spread=0.03: 0.03 >= 0.02 → fires
     * - Question B: effectiveThreshold=0.03 (null→SPREAD_THRESHOLD), spread=0.03: 0.03 >= 0.03 → fires
     *
     * Both fire. If the implementation mistakenly uses strict > instead of >=,
     * question B (spread == threshold) would NOT fire — catching the regression.
     */
    const dbPath = makeTempDbPath("th9");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");

    seedQuestionMatches(sqlite, THRESHOLD_QUESTION_A.id);
    seedQuestionMatches(sqlite, THRESHOLD_QUESTION_B.id);

    // Question A: lower per-question threshold
    setQuestionThreshold(sqlite, THRESHOLD_QUESTION_A.id, 0.02);
    // Question B: null (falls back to SPREAD_THRESHOLD=0.03)
    setQuestionThreshold(sqlite, THRESHOLD_QUESTION_B.id, null);

    clearInbox();
    const nowMs = Date.now();

    // Both spreads set to 0.03 (the default threshold)
    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_A.id, 0.03, nowMs);
    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_B.id, 0.03, nowMs);

    await invokeAlertDispatch(dbPath, nowMs);

    sqlite.close();

    const inbox = getInbox();

    expect(
      inbox.length,
      `Expected 2 alerts total (one per question) when both A and B have spread=0.03. ` +
        `Got ${inbox.length}. ` +
        `Question A (threshold=0.02): 0.03 >= 0.02 → fires. ` +
        `Question B (threshold=null→0.03): 0.03 >= 0.03 → fires (inclusive boundary). ` +
        `If inbox.length=1, one of the questions was incorrectly suppressed. ` +
        `If inbox.length=0, the threshold column is not being read or the dispatch is broken.`
    ).toBe(2);

    // Specifically verify question A fired (lower threshold fired at 3%)
    expect(
      inbox.some((e) => {
        const body = (e.html ?? "") + (e.text ?? "");
        return body.includes(THRESHOLD_QUESTION_A.query_text);
      }),
      `Question A ("${THRESHOLD_QUESTION_A.query_text}") did not fire. ` +
        `threshold=0.02, spread=0.03: 0.03 >= 0.02 → must fire.`
    ).toBe(true);

    // Specifically verify question B fired (null threshold, exact boundary 0.03)
    expect(
      inbox.some((e) => {
        const body = (e.html ?? "") + (e.text ?? "");
        return body.includes(THRESHOLD_QUESTION_B.query_text);
      }),
      `Question B ("${THRESHOLD_QUESTION_B.query_text}") did not fire. ` +
        `threshold=null (SPREAD_THRESHOLD=0.03), spread=0.03: 0.03 >= 0.03 → must fire. ` +
        `Boundary convention is >= (inclusive), matching Phase-1 alerts.ts line 113.`
    ).toBe(true);
  });

  it("question A (threshold=0.05, spread=0.03) suppressed; question B (null, spread=0.03) fires", async () => {
    /**
     * - Question A: effectiveThreshold=0.05, spread=0.03: 0.03 < 0.05 → does NOT fire
     * - Question B: effectiveThreshold=0.03 (null), spread=0.03: 0.03 >= 0.03 → fires
     * Only 1 alert total.
     */
    const dbPath = makeTempDbPath("th9b");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");

    seedQuestionMatches(sqlite, THRESHOLD_QUESTION_A.id);
    seedQuestionMatches(sqlite, THRESHOLD_QUESTION_B.id);

    // Question A: higher threshold — will be suppressed at spread=0.03
    setQuestionThreshold(sqlite, THRESHOLD_QUESTION_A.id, 0.05);
    // Question B: null (falls back to SPREAD_THRESHOLD=0.03)
    setQuestionThreshold(sqlite, THRESHOLD_QUESTION_B.id, null);

    clearInbox();
    const nowMs = Date.now();

    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_A.id, 0.03, nowMs);
    seedSpreadSnapshot(sqlite, THRESHOLD_QUESTION_B.id, 0.03, nowMs);

    await invokeAlertDispatch(dbPath, nowMs);

    sqlite.close();

    const inbox = getInbox();

    expect(
      inbox.length,
      `Expected 1 alert: question A (threshold=0.05, spread=0.03) suppressed; ` +
        `question B (threshold=null→0.03, spread=0.03) fires. Got ${inbox.length}. ` +
        `If inbox.length=2: question A is incorrectly firing below its threshold. ` +
        `If inbox.length=0: question B is incorrectly suppressed at the exact boundary.`
    ).toBe(1);

    // The one alert must be for question B
    expect(
      inbox.some((e) => {
        const body = (e.html ?? "") + (e.text ?? "");
        return body.includes(THRESHOLD_QUESTION_B.query_text);
      }),
      `The single alert must be for question B ("${THRESHOLD_QUESTION_B.query_text}"). ` +
        `Question A was suppressed (threshold=0.05 > spread=0.03).`
    ).toBe(true);

    // Question A must NOT be in the inbox
    expect(
      inbox.every((e) => {
        const body = (e.html ?? "") + (e.text ?? "");
        return !body.includes(THRESHOLD_QUESTION_A.query_text);
      }),
      `Question A ("${THRESHOLD_QUESTION_A.query_text}") appears in the inbox but should be suppressed. ` +
        `threshold=0.05 > spread=0.03 — the per-question threshold must block this alert.`
    ).toBe(true);
  });
});
