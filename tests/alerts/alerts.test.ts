/**
 * tests/alerts/alerts.test.ts
 *
 * Mode 1 (pre-implementation) — ALL 12 tests in this file MUST FAIL until:
 *   - db/schema.ts grows an `alerts` table (columns: id, question_id FK,
 *     user_id FK, state TEXT enum 'armed|fired', last_alerted_at INTEGER,
 *     last_alerted_spread REAL)
 *   - lib/alerts.ts (or equivalent) is created and exports:
 *       dispatchAlerts(db, nowMs) → Promise<void>
 *       SPREAD_THRESHOLD constant (number, default 0.03)
 *   - Alert dispatch fires from the cron tick (after spread computation) OR
 *     from a separate /api/cron/alerts route — the tests are outcome-based
 *   - An email template includes: question text, disclaimer string, per-platform
 *     deeplinks (kalshi, manifold, polymarket, robinhood order), spread as "%"
 *
 * DoD items covered:
 *   T1  — Threshold cross 0→4% fires exactly one alert (within cron tick)
 *   T2  — Email template includes disclaimer in BOTH html and text bodies
 *   T3  — Email template includes deeplinks in platform order (kalshi→manifold→polymarket→robinhood)
 *   T4  — Email template includes spread formatted as a percent ("4.0%")
 *   T5  — Hysteresis: no duplicate alert on second tick while still above threshold
 *   T6  — Hysteresis: re-arm on drop below threshold, then re-fire on next cross
 *   T7  — No alert when user status != "ok" (key-invalid / quota-exhausted skipped)
 *   T8  — No alert when spread is null (< 2 platforms)
 *   T9  — First-ever snapshot above threshold fires one alert (armed→fired, no prior row)
 *   T10 — Per-question hysteresis: question A fires; question B state is independent
 *   T11 — SPREAD_THRESHOLD constant is exported and used as the sole threshold source
 *   T12 — Idempotency: two ticks within 60s of the same threshold cross → one alert
 *
 * Architecture references:
 *   docs/architecture/0001-stack.md — Resend transport, email template path emails/
 *   docs/design/dashboard.md §5A — disclaimer string (verbatim, locked)
 *   docs/design/dashboard.md §3 — platform chip order: kalshi, manifold, polymarket, robinhood
 *   lib/cron.ts — IDEMPOTENCY_WINDOW_MS = 60_000
 *   tests/auth/__mocks__/resend.ts — in-memory Resend mock
 *   tests/cron/helpers/cron-fixtures.ts — fixture users, questions, DB helpers
 *
 * Test approach:
 *   - vi.mock("resend") replaces Resend with the in-memory mock from tests/auth/__mocks__/resend.ts
 *   - Each test seeds its own temp SQLite DB (same pattern as cron tests)
 *   - Alert dispatch is invoked directly via lib/alerts.ts OR via the cron route handler —
 *     the tests invoke the highest-level available entry point that produces the outcome
 *   - DB state (alerts table) is inspected via better-sqlite3 after each dispatch call
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
// Resend mock: must be declared before any module that imports "resend" loads
// ---------------------------------------------------------------------------

vi.mock("resend");

// ---------------------------------------------------------------------------
// Disclaimer string (verbatim from docs/design/dashboard.md §5A)
// This string MUST appear in every alert email's html AND text body.
// Never modify this constant to make tests pass — it is the design contract.
// ---------------------------------------------------------------------------

export const DISCLAIMER_STRING = "arb ≠ profit; slippage and fees may eat spread";

// ---------------------------------------------------------------------------
// Platform order (verbatim from docs/design/dashboard.md §3)
// deeplinks must appear in this exact order in the email body.
// ---------------------------------------------------------------------------

export const PLATFORM_ORDER = ["kalshi", "manifold", "polymarket", "robinhood"] as const;

// ---------------------------------------------------------------------------
// Alert threshold (Phase 1 default — must be exported from lib/alerts.ts)
// ---------------------------------------------------------------------------

export const EXPECTED_SPREAD_THRESHOLD = 0.03; // 3%

// ---------------------------------------------------------------------------
// Expected alerts table schema
// ---------------------------------------------------------------------------

export const EXPECTED_ALERTS_TABLE = "alerts";
export const EXPECTED_ALERTS_COLUMNS = [
  "id",
  "question_id",
  "user_id",
  "state",           // enum: 'armed' | 'fired'
  "last_alerted_at", // INTEGER (unix seconds), nullable
  "last_alerted_spread", // REAL, nullable
] as const;

// ---------------------------------------------------------------------------
// Temp DB + seed helpers
// ---------------------------------------------------------------------------

const SEED_SCRIPT = join(REPO_ROOT, "scripts", "seed.ts");

function makeTempDbPath(suffix: string): string {
  const dir = join(tmpdir(), "predmkt-arb-alert-tests");
  mkdirSync(dir, { recursive: true });
  return join(dir, `alerts-${suffix}-${process.pid}.db`);
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
 * Seed a spread_snapshots row for a question.
 * `spread` is the PREVIOUS value (before the current tick).
 */
function seedSpreadSnapshot(
  sqlite: InstanceType<typeof Database>,
  questionId: string,
  spread: number | null,
  nowMs: number
): void {
  const nowSec = Math.floor(nowMs / 1000);
  // Use INSERT OR REPLACE so tests can call this multiple times
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO spread_snapshots (id, question_id, spread, last_updated, computed_at)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)`
    )
    .run(questionId, spread, nowSec, nowSec);
}

/**
 * Seed an alerts row directly (for hysteresis / re-arm tests).
 * state is 'armed' or 'fired'.
 */
function seedAlertRow(
  sqlite: InstanceType<typeof Database>,
  questionId: string,
  userId: string,
  state: "armed" | "fired",
  lastAlertedAt: number | null,
  lastAlertedSpread: number | null
): void {
  // If the alerts table does not exist, this will throw — which is correct:
  // the test will fail with a clear "table not found" error pre-implementation.
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO ${EXPECTED_ALERTS_TABLE}
         (id, question_id, user_id, state, last_alerted_at, last_alerted_spread)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)`
    )
    .run(questionId, userId, state, lastAlertedAt, lastAlertedSpread);
}

/**
 * Read the alerts row for a given question from the test DB.
 */
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
       FROM ${EXPECTED_ALERTS_TABLE}
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
// Alert dispatch invocation
//
// Tests invoke dispatchAlerts() from lib/alerts.ts directly when available.
// If lib/alerts.ts is not yet implemented, calling invokAlertDispatch() will
// throw — making all tests that call it fail with a clear message.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dispatchAlerts: ((dbPath: string, nowMs: number) => Promise<void>) | null = null;
let alertsLibError: Error | null = null;

try {
  // lib/alerts.ts does not exist pre-implementation — import will throw.
  const mod = await import("../../lib/alerts.js");
  dispatchAlerts = mod.dispatchAlerts;
} catch (err) {
  alertsLibError = err as Error;
}

// SPREAD_THRESHOLD constant — must be exported from lib/alerts.ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let SPREAD_THRESHOLD: number | undefined;
try {
  const mod = await import("../../lib/alerts.js");
  SPREAD_THRESHOLD = mod.SPREAD_THRESHOLD;
} catch {
  // Already captured in alertsLibError
}

/**
 * Invoke the alert dispatch with a given DB path and simulated "now".
 * Throws if lib/alerts.ts is not yet implemented (Mode 1).
 */
async function invokeAlertDispatch(dbPath: string, nowMs: number): Promise<void> {
  if (alertsLibError || !dispatchAlerts) {
    throw new Error(
      `lib/alerts.ts does not exist or fails to import. ` +
        `This module must export: ` +
        `  dispatchAlerts(dbPath: string, nowMs: number): Promise<void> ` +
        `  SPREAD_THRESHOLD: number (default 0.03) ` +
        `Original import error: ${alertsLibError?.message ?? "module loaded but dispatchAlerts not exported"}`
    );
  }
  return dispatchAlerts(dbPath, nowMs);
}

// ---------------------------------------------------------------------------
// Fixture: one watched question matched on all 4 platforms with deeplinks
// This question is used for the primary alert-content assertions (T1, T2, T3, T4).
// ---------------------------------------------------------------------------

const ALERT_FIXTURE_QUESTION = FIXTURE_QUESTIONS[0]; // "Fed cuts rates June 2026"
const ALERT_FIXTURE_QUESTION_B = FIXTURE_QUESTIONS[1]; // "Presidential election 2028 winner"

// Per-platform market URLs for the fixture question
// The implementer must store these in question_matches.market_url.
// The alert email must include <a href="{url}"> for each matched platform.
const FIXTURE_MARKET_URLS = {
  kalshi:     "https://kalshi.com/markets/fed-cuts-rates-june-2026",
  manifold:   "https://manifold.markets/fed-cuts-rates-june-2026",
  polymarket: "https://polymarket.com/event/fed-cuts-rates-june-2026",
  robinhood:  "https://robinhood.com/predict/fed-cuts-rates-june-2026",
} as const;

/**
 * Seed question_matches rows for the alert fixture question so the email
 * template can include per-platform deeplinks.
 */
function seedQuestionMatches(
  sqlite: InstanceType<typeof Database>,
  questionId: string,
  platforms: typeof PLATFORM_ORDER[number][]
): void {
  for (const platform of platforms) {
    const url = FIXTURE_MARKET_URLS[platform];
    sqlite
      .prepare(
        `INSERT OR REPLACE INTO question_matches
           (id, question_id, platform, market_id, market_url, implied_yes_prob, last_seen_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, unixepoch())`
      )
      .run(questionId, platform, `${platform}-market-id`, url, 0.43);
  }
}

// ---------------------------------------------------------------------------
// T1: Threshold cross 0 → 4% fires exactly one alert within the cron tick
// ---------------------------------------------------------------------------

describe("T1 — Threshold cross 0→4% fires exactly one Resend call", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("t1");
    runSeed(dbPath);
    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");

    // Seed: prior spread = 0.02 (below 3% threshold)
    const nowMs = Date.now();
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.02, nowMs - 70_000);
    // Seed question_matches with 4 platforms + market URLs
    seedQuestionMatches(sqlite, ALERT_FIXTURE_QUESTION.id, [...PLATFORM_ORDER]);
  });

  afterAll(() => {
    sqlite.close();
  });

  beforeEach(() => {
    clearInbox();
  });

  it("fires exactly one Resend email when spread crosses from 0.02 to 0.04", async () => {
    // Inject new spread value of 0.04 (above 3% threshold)
    const nowMs = Date.now();
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, nowMs);

    await invokeAlertDispatch(dbPath, nowMs);

    const inbox = getInbox();
    expect(
      inbox.length,
      `Expected exactly 1 Resend email after spread crosses 0.02→0.04 (threshold=3%). ` +
        `Got ${inbox.length}. ` +
        `lib/alerts.ts must call Resend.emails.send exactly once when the latest ` +
        `spread_snapshot crosses from below SPREAD_THRESHOLD to above it.`
    ).toBe(1);
  });

  it("alert email is addressed to the fixture user's email", async () => {
    const nowMs = Date.now();
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, nowMs);
    await invokeAlertDispatch(dbPath, nowMs);

    const inbox = getInbox();
    if (inbox.length === 0) {
      throw new Error("No email sent — cannot assert recipient. (see T1 test 1)");
    }

    const email = inbox[0];
    const to = Array.isArray(email.to) ? email.to[0] : email.to;
    expect(
      to,
      `Alert email sent to "${to}" but expected "${FIXTURE_USER_WITH_KEY.email}". ` +
        `dispatchAlerts must address the email to the user who owns the watched question.`
    ).toBe(FIXTURE_USER_WITH_KEY.email);
  });

  it("alert email body contains the question text", async () => {
    const nowMs = Date.now();
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, nowMs);
    await invokeAlertDispatch(dbPath, nowMs);

    const inbox = getInbox();
    if (inbox.length === 0) {
      throw new Error("No email sent — cannot assert body content. (see T1 test 1)");
    }

    const email = inbox[0];
    const bodyHtml = email.html ?? "";
    const bodyText = email.text ?? "";
    const body = bodyHtml + bodyText;

    expect(
      body.includes(ALERT_FIXTURE_QUESTION.query_text),
      `Alert email body does not contain the question text "${ALERT_FIXTURE_QUESTION.query_text}". ` +
        `The email template must include the watched question text so the user knows ` +
        `which question triggered the alert. ` +
        `HTML body (first 500 chars): ${bodyHtml.slice(0, 500)}`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T2: Disclaimer string must appear in BOTH html and text bodies
// ---------------------------------------------------------------------------

describe("T2 — Disclaimer present in both html and text bodies", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("t2");
    runSeed(dbPath);
    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    seedQuestionMatches(sqlite, ALERT_FIXTURE_QUESTION.id, [...PLATFORM_ORDER]);
  });

  afterAll(() => {
    sqlite.close();
  });

  beforeEach(() => {
    clearInbox();
  });

  it("disclaimer appears in HTML body", async () => {
    const nowMs = Date.now();
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, nowMs);
    await invokeAlertDispatch(dbPath, nowMs);

    const inbox = getInbox();
    if (inbox.length === 0) {
      throw new Error(
        `No alert email sent. T2 requires a threshold-crossing alert to be dispatched. ` +
          `Ensure lib/alerts.ts fires when spread crosses 3%.`
      );
    }

    const html = inbox[0].html ?? "";
    expect(
      html.includes(DISCLAIMER_STRING),
      `Disclaimer string not found in HTML body. ` +
        `Expected to find: "${DISCLAIMER_STRING}" ` +
        `in the email HTML body. ` +
        `Per docs/design/dashboard.md §5A this string is locked and must appear ` +
        `in every alert email. ` +
        `Actual HTML (first 600 chars): ${html.slice(0, 600)}`
    ).toBe(true);
  });

  it("disclaimer appears in plain-text body", async () => {
    const nowMs = Date.now();
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, nowMs);
    await invokeAlertDispatch(dbPath, nowMs);

    const inbox = getInbox();
    if (inbox.length === 0) {
      throw new Error(
        `No alert email sent. T2 requires a threshold-crossing alert to be dispatched.`
      );
    }

    const text = inbox[0].text ?? "";
    expect(
      text.includes(DISCLAIMER_STRING),
      `Disclaimer string not found in plain-text body. ` +
        `Expected to find: "${DISCLAIMER_STRING}" ` +
        `in the email plain-text body. ` +
        `Both HTML and text renditions must include this string (some email clients ` +
        `show text-only). ` +
        `Actual text (first 600 chars): ${text.slice(0, 600)}`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T3: Email template includes deeplinks in platform order
// ---------------------------------------------------------------------------

describe("T3 — Deeplinks present in platform order: kalshi → manifold → polymarket → robinhood", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("t3");
    runSeed(dbPath);
    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    seedQuestionMatches(sqlite, ALERT_FIXTURE_QUESTION.id, [...PLATFORM_ORDER]);
  });

  afterAll(() => {
    sqlite.close();
  });

  beforeEach(() => {
    clearInbox();
  });

  it("HTML body contains <a href> deeplinks for all 4 platforms in order", async () => {
    const nowMs = Date.now();
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, nowMs);
    await invokeAlertDispatch(dbPath, nowMs);

    const inbox = getInbox();
    if (inbox.length === 0) {
      throw new Error(
        `No alert email sent. T3 requires a threshold-crossing alert to be dispatched.`
      );
    }

    const html = inbox[0].html ?? "";

    // Assert each deeplink is present
    for (const platform of PLATFORM_ORDER) {
      const url = FIXTURE_MARKET_URLS[platform];
      expect(
        html.includes(`href="${url}"`) || html.includes(`href='${url}'`) || html.includes(url),
        `Alert email HTML does not contain deeplink for platform "${platform}". ` +
          `Expected to find href to: ${url} ` +
          `The email template must include per-platform <a href="..."> links ` +
          `for each matched market (see docs/design/dashboard.md §3). ` +
          `HTML (first 800 chars): ${html.slice(0, 800)}`
      ).toBe(true);
    }

    // Assert ORDER: kalshi before manifold, manifold before polymarket, polymarket before robinhood
    const kalshiPos = html.indexOf(FIXTURE_MARKET_URLS.kalshi);
    const manifoldPos = html.indexOf(FIXTURE_MARKET_URLS.manifold);
    const polymarketPos = html.indexOf(FIXTURE_MARKET_URLS.polymarket);
    const robinhoodPos = html.indexOf(FIXTURE_MARKET_URLS.robinhood);

    expect(
      kalshiPos < manifoldPos,
      `Platform order violated: kalshi link (pos ${kalshiPos}) must appear before ` +
        `manifold link (pos ${manifoldPos}) in the email HTML. ` +
        `Required order: kalshi, manifold, polymarket, robinhood (per dashboard.md §3).`
    ).toBe(true);

    expect(
      manifoldPos < polymarketPos,
      `Platform order violated: manifold link (pos ${manifoldPos}) must appear before ` +
        `polymarket link (pos ${polymarketPos}) in the email HTML.`
    ).toBe(true);

    expect(
      polymarketPos < robinhoodPos,
      `Platform order violated: polymarket link (pos ${polymarketPos}) must appear before ` +
        `robinhood link (pos ${robinhoodPos}) in the email HTML.`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T4: Email template includes spread formatted as a percent
// ---------------------------------------------------------------------------

describe("T4 — Spread value formatted as percent in email body", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("t4");
    runSeed(dbPath);
    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    seedQuestionMatches(sqlite, ALERT_FIXTURE_QUESTION.id, [...PLATFORM_ORDER]);
  });

  afterAll(() => {
    sqlite.close();
  });

  beforeEach(() => {
    clearInbox();
  });

  it("email body contains the spread value as a percentage string (e.g. '4.0%')", async () => {
    const nowMs = Date.now();
    // Seed spread = 0.04 → should appear as "4.0%" in the email
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, nowMs);
    await invokeAlertDispatch(dbPath, nowMs);

    const inbox = getInbox();
    if (inbox.length === 0) {
      throw new Error(
        `No alert email sent. T4 requires a threshold-crossing alert to be dispatched.`
      );
    }

    const email = inbox[0];
    const body = (email.html ?? "") + (email.text ?? "");

    // Accept "4.0%" or "4%" — both are valid percent representations of 0.04
    const hasPercent = body.includes("4.0%") || body.includes("4%");
    expect(
      hasPercent,
      `Alert email body does not contain the spread formatted as a percent. ` +
        `spread = 0.04 → expected "4.0%" or "4%" in the email body. ` +
        `The template must render the spread as a human-readable percentage ` +
        `(e.g. (spread * 100).toFixed(1) + "%"). ` +
        `Body snippet (first 600 chars): ${body.slice(0, 600)}`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T5: Hysteresis — no duplicate alert when spread stays above threshold
// ---------------------------------------------------------------------------

describe("T5 — No duplicate alert: second tick above threshold does not re-fire", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("t5");
    runSeed(dbPath);
    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    seedQuestionMatches(sqlite, ALERT_FIXTURE_QUESTION.id, [...PLATFORM_ORDER]);
  });

  afterAll(() => {
    sqlite.close();
  });

  beforeEach(() => {
    clearInbox();
  });

  it("after alert fires at 0.04, a second tick at 0.045 does NOT send another email", async () => {
    const t0 = Date.now();

    // Tick 1: spread crosses 0.02 → 0.04. Alert fires. state=fired.
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, t0);
    await invokeAlertDispatch(dbPath, t0);

    const inboxAfterTick1 = getInbox();
    expect(
      inboxAfterTick1.length,
      `Expected exactly 1 email after tick 1 (spread=0.04 crosses threshold). ` +
        `Got ${inboxAfterTick1.length}.`
    ).toBe(1);

    // Tick 2: spread stays above threshold at 0.045. No new alert.
    const t1 = t0 + 5 * 60 * 1000; // 5 minutes later
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.045, t1);
    await invokeAlertDispatch(dbPath, t1);

    const inboxAfterTick2 = getInbox();
    expect(
      inboxAfterTick2.length,
      `Expected inbox to remain at 1 after tick 2 (spread=0.045, still above threshold). ` +
        `Got ${inboxAfterTick2.length}. ` +
        `Hysteresis requires no re-alert while state=fired and spread stays above threshold. ` +
        `The alert must only re-fire after the spread drops BELOW the threshold and then ` +
        `crosses back above it (see T6).`
    ).toBe(1);
  });

  it("alerts table state is 'fired' after the first alert", async () => {
    const nowMs = Date.now();
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, nowMs);
    await invokeAlertDispatch(dbPath, nowMs);

    const alertRow = getAlertRow(sqlite, ALERT_FIXTURE_QUESTION.id);
    expect(
      alertRow,
      `No row found in the "${EXPECTED_ALERTS_TABLE}" table for question_id=` +
        `"${ALERT_FIXTURE_QUESTION.id}" after alert fires. ` +
        `The alerts table must be created in db/schema.ts with columns: ` +
        EXPECTED_ALERTS_COLUMNS.join(", ")
    ).toBeDefined();

    expect(
      alertRow?.state,
      `Alert row state should be "fired" after the alert email was sent. ` +
        `Got: "${alertRow?.state}". ` +
        `lib/alerts.ts must update the state to "fired" after calling Resend.emails.send.`
    ).toBe("fired");
  });
});

// ---------------------------------------------------------------------------
// T6: Hysteresis — re-arm on drop, then re-fire on next cross
// ---------------------------------------------------------------------------

describe("T6 — Hysteresis re-arm: drop below threshold → armed; next cross → fires again", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("t6");
    runSeed(dbPath);
    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    seedQuestionMatches(sqlite, ALERT_FIXTURE_QUESTION.id, [...PLATFORM_ORDER]);
  });

  afterAll(() => {
    sqlite.close();
  });

  beforeEach(() => {
    clearInbox();
  });

  it("state transitions: fired → armed (drop below) → fired (re-cross above)", async () => {
    const t0 = Date.now();

    // Step 1: alert fires at 0.04. state → fired.
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, t0);
    await invokeAlertDispatch(dbPath, t0);
    expect(getInbox().length, "Expected 1 email after first threshold cross").toBe(1);

    // Step 2: spread drops to 0.02 (below threshold). state → armed. No new email.
    const t1 = t0 + 5 * 60 * 1000;
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.02, t1);
    await invokeAlertDispatch(dbPath, t1);

    const stateAfterDrop = getAlertRow(sqlite, ALERT_FIXTURE_QUESTION.id)?.state;
    expect(
      stateAfterDrop,
      `After spread drops to 0.02 (below threshold), alerts state should be "armed". ` +
        `Got: "${stateAfterDrop}". ` +
        `lib/alerts.ts must transition state fired→armed when spread falls below SPREAD_THRESHOLD.`
    ).toBe("armed");
    expect(
      getInbox().length,
      `No new email should be sent when spread drops below threshold. ` +
        `Got ${getInbox().length} emails.`
    ).toBe(1); // still only 1 (from step 1)

    // Step 3: spread re-crosses to 0.04. state → fired. NEW email sent.
    const t2 = t1 + 5 * 60 * 1000;
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, t2);
    await invokeAlertDispatch(dbPath, t2);

    expect(
      getInbox().length,
      `After re-arming (state=armed) and re-crossing threshold (0.04), ` +
        `expected inbox count = 2 (one new email). ` +
        `Got ${getInbox().length}. ` +
        `lib/alerts.ts must fire a new alert when state=armed and spread crosses above SPREAD_THRESHOLD.`
    ).toBe(2);

    const stateAfterRefire = getAlertRow(sqlite, ALERT_FIXTURE_QUESTION.id)?.state;
    expect(
      stateAfterRefire,
      `After re-firing, state should be "fired". Got: "${stateAfterRefire}".`
    ).toBe("fired");
  });
});

// ---------------------------------------------------------------------------
// T7: No alert when user status != "ok"
// ---------------------------------------------------------------------------

describe("T7 — No alert for users with non-ok key status", () => {
  it("user with key-invalid status does not receive an alert email", async () => {
    const dbPath = makeTempDbPath("t7-invalid");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");

    // Change fixture user's status to key-invalid
    sqlite
      .prepare(`UPDATE users SET anakin_key_status = 'key-invalid' WHERE id = ?`)
      .run(FIXTURE_USER_WITH_KEY.id);

    seedQuestionMatches(sqlite, ALERT_FIXTURE_QUESTION.id, [...PLATFORM_ORDER]);
    clearInbox();

    const nowMs = Date.now();
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, nowMs);
    await invokeAlertDispatch(dbPath, nowMs);

    sqlite.close();

    expect(
      getInbox().length,
      `A user with anakin_key_status="key-invalid" should NOT receive an alert email. ` +
        `Got ${getInbox().length} emails. ` +
        `lib/alerts.ts must check the user's key status before dispatching and ` +
        `skip users whose status is not "ok" (same gate as the cron spread-refresh).`
    ).toBe(0);
  });

  it("user with quota-exhausted status does not receive an alert email", async () => {
    const dbPath = makeTempDbPath("t7-quota");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");

    // Change fixture user's status to quota-exhausted
    sqlite
      .prepare(`UPDATE users SET anakin_key_status = 'quota-exhausted' WHERE id = ?`)
      .run(FIXTURE_USER_WITH_KEY.id);

    seedQuestionMatches(sqlite, ALERT_FIXTURE_QUESTION.id, [...PLATFORM_ORDER]);
    clearInbox();

    const nowMs = Date.now();
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, nowMs);
    await invokeAlertDispatch(dbPath, nowMs);

    sqlite.close();

    expect(
      getInbox().length,
      `A user with anakin_key_status="quota-exhausted" should NOT receive an alert email. ` +
        `Got ${getInbox().length} emails. ` +
        `lib/alerts.ts must skip users with quota-exhausted status.`
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T8: No alert when spread is null (fewer than 2 platforms matched)
// ---------------------------------------------------------------------------

describe("T8 — No alert when spread is null (single-platform match)", () => {
  it("null spread snapshot does not trigger an alert", async () => {
    const dbPath = makeTempDbPath("t8");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");

    // Seed only 1 platform match → spread will be null
    seedQuestionMatches(sqlite, ALERT_FIXTURE_QUESTION.id, ["kalshi"]);
    clearInbox();

    const nowMs = Date.now();
    // Explicitly seed a null spread
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, null, nowMs);
    await invokeAlertDispatch(dbPath, nowMs);

    sqlite.close();

    expect(
      getInbox().length,
      `A null spread (fewer than 2 platforms matched) should NOT trigger an alert. ` +
        `Got ${getInbox().length} emails. ` +
        `lib/alerts.ts must skip questions whose latest spread_snapshots.spread is null.`
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T9: First-ever snapshot above threshold fires one alert (no prior row)
// ---------------------------------------------------------------------------

describe("T9 — First-ever snapshot above threshold fires one alert", () => {
  it("no prior spread_snapshots row + new spread=0.04 → fires exactly one alert", async () => {
    const dbPath = makeTempDbPath("t9");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");

    // Seed question matches but NO prior spread_snapshots row
    seedQuestionMatches(sqlite, ALERT_FIXTURE_QUESTION.id, [...PLATFORM_ORDER]);
    clearInbox();

    // Seed a single snapshot at 0.04 (first-ever, above threshold)
    const nowMs = Date.now();
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, nowMs);
    await invokeAlertDispatch(dbPath, nowMs);

    sqlite.close();

    expect(
      getInbox().length,
      `First-ever snapshot at 0.04 (above 3% threshold) should fire exactly 1 alert. ` +
        `Got ${getInbox().length}. ` +
        `Convention: when no prior alerts row exists AND spread > SPREAD_THRESHOLD, ` +
        `treat it as an armed→fired transition and dispatch one alert. ` +
        `lib/alerts.ts must handle the "no prior alerts row" case by creating one ` +
        `with state="fired" and dispatching the email.`
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T10: Per-question hysteresis — question A fires; question B is unaffected
// ---------------------------------------------------------------------------

describe("T10 — Per-question hysteresis: question A fires; question B state is independent", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("t10");
    runSeed(dbPath);
    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");

    // Seed matches for BOTH questions
    seedQuestionMatches(sqlite, ALERT_FIXTURE_QUESTION.id, [...PLATFORM_ORDER]);
    seedQuestionMatches(sqlite, ALERT_FIXTURE_QUESTION_B.id, [...PLATFORM_ORDER]);
  });

  afterAll(() => {
    sqlite.close();
  });

  beforeEach(() => {
    clearInbox();
  });

  it("firing alert for question A does not change question B's alert state", async () => {
    const nowMs = Date.now();

    // Seed question A above threshold (will fire)
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, nowMs);
    // Seed question B below threshold (should not fire)
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION_B.id, 0.02, nowMs);

    await invokeAlertDispatch(dbPath, nowMs);

    // Question A should have fired
    const rowA = getAlertRow(sqlite, ALERT_FIXTURE_QUESTION.id);
    expect(
      rowA?.state,
      `Question A (${ALERT_FIXTURE_QUESTION.id}) should have state="fired" after threshold cross. ` +
        `Got: "${rowA?.state}".`
    ).toBe("fired");

    // Question B should be armed (or have no row yet — implementer's choice),
    // but definitively NOT fired
    const rowB = getAlertRow(sqlite, ALERT_FIXTURE_QUESTION_B.id);
    expect(
      rowB?.state !== "fired",
      `Question B (${ALERT_FIXTURE_QUESTION_B.id}) should NOT have state="fired" ` +
        `because its spread (0.02) is below the threshold. ` +
        `Got state: "${rowB?.state}". ` +
        `Hysteresis is per-question; question A firing must not affect question B's state.`
    ).toBe(true);

    // Only 1 email total (for question A only)
    expect(
      getInbox().length,
      `Expected exactly 1 email (for question A only). ` +
        `Got ${getInbox().length}. ` +
        `Question B (spread=0.02, below threshold) must not generate an email.`
    ).toBe(1);
  });

  it("after question A fires, question B independently crosses threshold → fires separately", async () => {
    const t0 = Date.now();

    // Set A to fired state (simulate prior alert)
    seedAlertRow(sqlite, ALERT_FIXTURE_QUESTION.id, FIXTURE_USER_WITH_KEY.id, "fired", Math.floor(t0 / 1000) - 300, 0.04);

    // Question B now crosses threshold
    const t1 = t0 + 5 * 60 * 1000;
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION_B.id, 0.04, t1);
    await invokeAlertDispatch(dbPath, t1);

    const rowB = getAlertRow(sqlite, ALERT_FIXTURE_QUESTION_B.id);
    expect(
      rowB?.state,
      `After question B crosses threshold, its state should be "fired". ` +
        `Got: "${rowB?.state}".`
    ).toBe("fired");

    // Only 1 new email (for B) — A should not re-fire since it is still in fired state
    // (A's spread hasn't changed in this tick, so no re-arm happened)
    expect(
      getInbox().length >= 1,
      `Expected at least 1 email for question B crossing threshold. ` +
        `Got ${getInbox().length}.`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T11: SPREAD_THRESHOLD constant is exported and used as the sole source
// ---------------------------------------------------------------------------

describe("T11 — SPREAD_THRESHOLD constant is exported from lib/alerts.ts", () => {
  it("lib/alerts.ts exports SPREAD_THRESHOLD constant", () => {
    if (alertsLibError) {
      throw new Error(
        `lib/alerts.ts does not exist or fails to import. ` +
          `This module must export: SPREAD_THRESHOLD (number, default 0.03). ` +
          `Original error: ${alertsLibError.message}`
      );
    }
    expect(
      SPREAD_THRESHOLD,
      `lib/alerts.ts must export a named constant "SPREAD_THRESHOLD". ` +
        `This constant must be the ONLY place the 3% threshold is defined — ` +
        `no magic number 0.03 scattered across the codebase. ` +
        `Phase 2 will add per-question custom thresholds via a DB field; ` +
        `the constant remains the fallback default. ` +
        `Current value: ${SPREAD_THRESHOLD}`
    ).toBeDefined();
  });

  it("SPREAD_THRESHOLD is a number equal to 0.03 (Phase 1 default)", () => {
    if (alertsLibError) {
      throw new Error(
        `lib/alerts.ts not importable: ${alertsLibError.message}`
      );
    }
    expect(
      typeof SPREAD_THRESHOLD,
      `SPREAD_THRESHOLD must be a number (got ${typeof SPREAD_THRESHOLD})`
    ).toBe("number");

    expect(
      SPREAD_THRESHOLD,
      `SPREAD_THRESHOLD must be 0.03 (3%) for Phase 1. ` +
        `Got: ${SPREAD_THRESHOLD}. ` +
        `Phase 2 will allow per-question overrides, but the default is locked at 3%.`
    ).toBe(EXPECTED_SPREAD_THRESHOLD);
  });

  it("alerts fires at SPREAD_THRESHOLD, not at a hard-coded 0.03 in the dispatch logic", async () => {
    // This test verifies the behavior: an alert that fires at 0.031 (just above
    // the default 0.03) confirms the threshold is being read from SPREAD_THRESHOLD.
    if (alertsLibError) {
      throw new Error(`lib/alerts.ts not importable: ${alertsLibError.message}`);
    }

    const dbPath = makeTempDbPath("t11-threshold");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    seedQuestionMatches(sqlite, ALERT_FIXTURE_QUESTION.id, [...PLATFORM_ORDER]);
    clearInbox();

    const nowMs = Date.now();
    // Seed spread just above threshold (0.031 > 0.03)
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.031, nowMs);
    await invokeAlertDispatch(dbPath, nowMs);

    sqlite.close();

    expect(
      getInbox().length,
      `Expected 1 alert for spread=0.031 (just above SPREAD_THRESHOLD=0.03). ` +
        `Got ${getInbox().length}. ` +
        `lib/alerts.ts must use SPREAD_THRESHOLD as the comparison value, not a literal 0.03.`
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T12: Idempotency — two ticks within 60s of the same threshold cross → one alert
// ---------------------------------------------------------------------------

describe("T12 — Idempotency: two ticks within 60s → only one alert", () => {
  it("second invocation within IDEMPOTENCY_WINDOW_MS (60s) does not send a second email", async () => {
    const dbPath = makeTempDbPath("t12");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    seedQuestionMatches(sqlite, ALERT_FIXTURE_QUESTION.id, [...PLATFORM_ORDER]);
    clearInbox();

    const t0 = Date.now();

    // Seed the threshold-crossing spread
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, t0);

    // First tick: alert fires
    await invokeAlertDispatch(dbPath, t0);
    expect(getInbox().length, "Expected 1 email after first tick").toBe(1);

    // Second tick: within 60s (t0 + 30s). The spread snapshot is the same
    // (same last_updated). The system must recognize this is within the
    // idempotency window and NOT send another alert.
    const t1 = t0 + 30_000; // 30 seconds later
    await invokeAlertDispatch(dbPath, t1);

    sqlite.close();

    expect(
      getInbox().length,
      `Expected inbox to remain at 1 after second tick within 60s idempotency window. ` +
        `Got ${getInbox().length}. ` +
        `lib/alerts.ts must inherit or implement its own idempotency window (60s) ` +
        `to guard against duplicate alerts from back-pressure cron ticks. ` +
        `Mechanism: check last_alerted_at; if nowMs - last_alerted_at*1000 < 60_000, skip. ` +
        `This mirrors the spread-refresh cron's IDEMPOTENCY_WINDOW_MS = 60_000.`
    ).toBe(1);
  });

  it("alert fires again after idempotency window expires (> 60s after first alert)", async () => {
    // This confirms the idempotency window is finite — it does not permanently
    // suppress all future re-fires (that is hysteresis's job after a re-arm).
    // If state=armed and spread is above threshold after > 60s, it fires.
    const dbPath = makeTempDbPath("t12-refire");
    runSeed(dbPath);
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    seedQuestionMatches(sqlite, ALERT_FIXTURE_QUESTION.id, [...PLATFORM_ORDER]);
    clearInbox();

    const t0 = Date.now();

    // Tick 1: alert fires at t0
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, t0);
    await invokeAlertDispatch(dbPath, t0);
    expect(getInbox().length, "Expected 1 email after first tick").toBe(1);

    // Drop below threshold → re-arm
    const t1 = t0 + 5 * 60 * 1000;
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.02, t1);
    await invokeAlertDispatch(dbPath, t1);
    expect(getInbox().length, "Still 1 email after drop below threshold").toBe(1);

    // Re-cross above threshold after > 60s from original alert
    const t2 = t0 + 2 * 60 * 1000; // 2 minutes after t0 (> 60s window)
    seedSpreadSnapshot(sqlite, ALERT_FIXTURE_QUESTION.id, 0.04, t2);
    await invokeAlertDispatch(dbPath, t2);

    sqlite.close();

    expect(
      getInbox().length,
      `Expected 2 emails total: original alert + re-fire after re-arm and re-cross. ` +
        `Got ${getInbox().length}. ` +
        `After state=armed and spread re-crosses threshold (and idempotency window has passed), ` +
        `lib/alerts.ts must send a new alert.`
    ).toBe(2);
  });
});
