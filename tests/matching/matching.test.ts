/**
 * tests/matching/matching.test.ts
 *
 * Mode 1 (pre-implementation) — ALL tests in this file MUST FAIL until:
 *   - lib/matching.ts exports matchQuestion(userId, questionId, queryText)
 *   - lib/wire/mapping.ts exports extractImpliedYesProb(platform, payload)
 *   - db/schema.ts has a question_matches table with shape:
 *       (id, question_id FK watched_questions, platform enum, market_id,
 *        market_url, implied_yes_prob, last_seen_at)
 *   - The seed script inserts the 5 matching-queries into watched_questions
 *     (or the tests set them up directly via the DB helper).
 *
 * Architecture references:
 *   - ADR-0002 §"Field mapping per platform" — implied_yes_prob convention
 *   - ADR-0002 §"Local-dev fixture mode" — WIRE_MODE=fixtures
 *   - ADR-0002 §"Error taxonomy" — key-missing | key-invalid etc.
 *   - tests/fixtures/wire/README.md — fixture layout + seeded queries
 *   - tests/seeds/matching-queries.yaml — 5 seeded queries + expected platforms
 *
 * Expected failures before lib/matching.ts exists:
 *   - "Cannot find module '../../lib/matching'" (or equivalent)
 *   - All assertion-based tests fail with explicit messages pinpointing the
 *     missing table / function / behaviour.
 *
 * WIRE_MODE is set to "fixtures" by vitest.config.ts / vitest.workspace.ts
 * for the "other" project, so no live HTTP calls are made.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "yaml";

// ---------------------------------------------------------------------------
// Attempt to import the not-yet-implemented matching module.
// The import is wrapped so the file still loads (allowing individual tests to
// produce clear assertion failures rather than a single top-level crash).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let matchQuestion: (userId: string, questionId: string, queryText: string) => Promise<any[]>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractImpliedYesProb: (platform: string, payload: unknown) => number | null;

let matchingModuleError: Error | null = null;
let mappingModuleError: Error | null = null;

try {
  // lib/matching.ts does not exist pre-implementation — this will throw.
  const matchingMod = await import("../../lib/matching.js");
  matchQuestion = matchingMod.matchQuestion;
} catch (err) {
  matchingModuleError = err as Error;
}

try {
  // lib/wire/mapping.ts may not exist pre-implementation — this will throw.
  const mappingMod = await import("../../lib/wire/mapping.js");
  extractImpliedYesProb = mappingMod.extractImpliedYesProb;
} catch (err) {
  mappingModuleError = err as Error;
}

// ---------------------------------------------------------------------------
// Seed data — 5 matching queries from tests/seeds/matching-queries.yaml
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

interface MatchingQuery {
  id: string;
  query_text: string;
  slug: string;
  user_id: string;
  expected_platforms: string[];
}

interface MatchingQueriesSeed {
  fixture_user: { id: string; email: string };
  matching_questions: MatchingQuery[];
}

const seedData = yaml.parse(
  readFileSync(join(REPO_ROOT, "tests/seeds/matching-queries.yaml"), "utf8")
) as MatchingQueriesSeed;

const FIXTURE_USER_ID = seedData.fixture_user.id;
const MATCHING_QUERIES = seedData.matching_questions;

/** Queries expected to match all 4 platforms (≥3 required by DoD). */
const FOUR_PLATFORM_QUERIES = MATCHING_QUERIES.filter(
  (q) => q.expected_platforms.length === 4
);

const ALL_PLATFORMS = ["kalshi", "manifold", "polymarket", "robinhood"] as const;
type Platform = typeof ALL_PLATFORMS[number];

// ---------------------------------------------------------------------------
// DB setup for question_matches assertions
// ---------------------------------------------------------------------------

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const DB_URL = process.env.DATABASE_URL ?? "file:./local.db";
const DB_FILE = DB_URL.startsWith("file:") ? DB_URL.slice(5) : DB_URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqlite: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeAll(() => {
  sqlite = new Database(DB_FILE);
  sqlite.pragma("journal_mode = WAL");
  db = drizzle(sqlite);
  // Migrations are expected to include the question_matches table.
  // This will fail (or be a no-op) if the migration doesn't exist yet,
  // which is the correct pre-implementation failure mode.
  try {
    migrate(db, { migrationsFolder: join(REPO_ROOT, "drizzle") });
  } catch {
    // Migration may fail pre-implementation if question_matches migration
    // is not yet generated. Tests that query the table will surface this.
  }
});

afterAll(() => {
  if (sqlite) sqlite.close();
});

// Clean up any rows inserted by tests to keep runs idempotent.
afterEach(() => {
  if (!sqlite) return;
  try {
    // Only delete rows seeded by these tests (matching question ids).
    const ids = MATCHING_QUERIES.map((q) => `'${q.id}'`).join(", ");
    sqlite.prepare(`DELETE FROM question_matches WHERE question_id IN (${ids})`).run();
  } catch {
    // question_matches table may not exist yet — that's expected pre-implementation.
  }
});

// ---------------------------------------------------------------------------
// Helper: get question_matches rows for a given question_id from the DB
// ---------------------------------------------------------------------------

function getMatchRows(questionId: string): Array<{
  id: string;
  question_id: string;
  platform: string;
  market_id: string;
  market_url: string | null;
  implied_yes_prob: number | null;
  last_seen_at: number | null;
}> {
  try {
    return sqlite
      .prepare("SELECT * FROM question_matches WHERE question_id = ?")
      .all(questionId);
  } catch (err) {
    throw new Error(
      `Failed to query question_matches table. ` +
        `This table must be added to db/schema.ts with shape: ` +
        `(id, question_id FK watched_questions, platform TEXT, market_id TEXT, ` +
        `market_url TEXT, implied_yes_prob REAL, last_seen_at INTEGER). ` +
        `Original error: ${(err as Error).message}`
    );
  }
}

// ---------------------------------------------------------------------------
// DoD 1: Fixture mode never hits the network
// ---------------------------------------------------------------------------

describe("DoD 1 — Fixture mode never hits the network", () => {
  it("WIRE_MODE is set to 'fixtures' in the test environment", () => {
    expect(
      process.env.WIRE_MODE,
      "WIRE_MODE env var is not 'fixtures'. " +
        "vitest.config.ts / vitest.workspace.ts must set WIRE_MODE=fixtures for tests. " +
        "This prevents any live Wire HTTP calls during the test suite."
    ).toBe("fixtures");
  });

  it("fetch is never called for any of the 5 seeded queries (fixture short-circuit)", async () => {
    if (matchingModuleError) {
      throw new Error(
        `Cannot import lib/matching.ts: ${matchingModuleError.message}. ` +
          `This module must be created before this test can pass.`
      );
    }

    const fetchSpy = vi.spyOn(global, "fetch");

    // Ensure the fixture user has a key set up (seed must have run)
    // Run all 5 queries
    for (const q of MATCHING_QUERIES) {
      await matchQuestion(FIXTURE_USER_ID, q.id, q.query_text).catch(() => {
        // Errors from missing table etc. are fine — we only care that fetch wasn't called
      });
    }

    expect(
      fetchSpy.mock.calls.length,
      `fetch was called ${fetchSpy.mock.calls.length} time(s) during fixture-mode matching. ` +
        `When WIRE_MODE=fixtures, lib/wire/client.ts must short-circuit before any HTTP call. ` +
        `ADR-0002 §"Local-dev fixture mode": the fixture switch happens inside the wrapper ` +
        `before any network call is issued.`
    ).toBe(0);

    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// DoD 2: Free-text query → per-platform market refs
// ---------------------------------------------------------------------------

describe("DoD 2 — Free-text query produces per-platform market refs", () => {
  it("lib/matching.ts exports matchQuestion", () => {
    expect(
      matchingModuleError,
      `lib/matching.ts does not exist or fails to import. ` +
        `Error: ${matchingModuleError?.message}. ` +
        `Create lib/matching.ts and export: ` +
        `matchQuestion(userId: string, questionId: string, queryText: string): Promise<MatchRow[]>`
    ).toBeNull();

    expect(
      typeof matchQuestion,
      "matchQuestion is not a function. lib/matching.ts must export matchQuestion."
    ).toBe("function");
  });

  for (const query of FOUR_PLATFORM_QUERIES) {
    it(`query "${query.query_text}" produces 4 question_matches rows (one per platform)`, async () => {
      if (matchingModuleError) {
        throw new Error(`lib/matching.ts not importable: ${matchingModuleError.message}`);
      }

      await matchQuestion(FIXTURE_USER_ID, query.id, query.query_text);

      const rows = getMatchRows(query.id);

      expect(
        rows.length,
        `Expected 4 rows in question_matches for question_id="${query.id}" ` +
          `(query: "${query.query_text}") but found ${rows.length}. ` +
          `matchQuestion must insert one row per matched platform. ` +
          `Fixture coverage for this query: all 4 platforms. ` +
          `See tests/fixtures/wire/ for the fixture files.`
      ).toBe(4);

      const foundPlatforms = rows.map((r) => r.platform).sort();
      expect(
        foundPlatforms,
        `Platform set mismatch for "${query.query_text}". ` +
          `Expected: ${JSON.stringify(ALL_PLATFORMS.slice().sort())}. ` +
          `Got: ${JSON.stringify(foundPlatforms)}.`
      ).toEqual([...ALL_PLATFORMS].sort());
    });

    it(`each row for "${query.query_text}" has a non-null market_id`, async () => {
      if (matchingModuleError) {
        throw new Error(`lib/matching.ts not importable: ${matchingModuleError.message}`);
      }

      await matchQuestion(FIXTURE_USER_ID, query.id, query.query_text);
      const rows = getMatchRows(query.id);

      for (const row of rows) {
        expect(
          row.market_id,
          `Row for platform="${row.platform}" has null/empty market_id. ` +
            `matchQuestion must extract and store the market_id from the Wire fixture payload.`
        ).toBeTruthy();
      }
    });

    it(`each row for "${query.query_text}" has a non-null numeric implied_yes_prob`, async () => {
      if (matchingModuleError) {
        throw new Error(`lib/matching.ts not importable: ${matchingModuleError.message}`);
      }

      await matchQuestion(FIXTURE_USER_ID, query.id, query.query_text);
      const rows = getMatchRows(query.id);

      for (const row of rows) {
        expect(
          typeof row.implied_yes_prob === "number" && isFinite(row.implied_yes_prob),
          `Row for platform="${row.platform}", question="${query.query_text}" ` +
            `has implied_yes_prob=${row.implied_yes_prob} which is not a finite number. ` +
            `matchQuestion must compute implied_yes_prob via extractImpliedYesProb ` +
            `(ADR-0002 §"Field mapping per platform") and store the result.`
        ).toBe(true);

        expect(
          row.implied_yes_prob! >= 0 && row.implied_yes_prob! <= 1,
          `implied_yes_prob=${row.implied_yes_prob} for platform="${row.platform}" ` +
            `is outside [0, 1]. All probability values must be normalised to [0, 1].`
        ).toBe(true);
      }
    });
  }

  it("query 'nyc-mayor-2025' produces only 2 rows (kalshi + polymarket)", async () => {
    if (matchingModuleError) {
      throw new Error(`lib/matching.ts not importable: ${matchingModuleError.message}`);
    }

    const query = MATCHING_QUERIES.find((q) => q.slug === "nyc-mayor-2025")!;
    expect(query, "nyc-mayor-2025 not found in matching-queries.yaml").toBeDefined();

    await matchQuestion(FIXTURE_USER_ID, query.id, query.query_text);
    const rows = getMatchRows(query.id);

    expect(
      rows.length,
      `Expected 2 rows for "NYC mayor 2025 election" ` +
        `(kalshi + polymarket only, per tests/fixtures/wire/README.md) ` +
        `but found ${rows.length}. ` +
        `Platforms found: ${rows.map((r) => r.platform).join(", ")}. ` +
        `When a platform returns an empty fixture (no markets), ` +
        `matchQuestion must NOT insert a row for that platform.`
    ).toBe(2);

    const platforms = rows.map((r) => r.platform).sort();
    expect(platforms).toEqual(["kalshi", "polymarket"].sort());
  });

  it("query 'oscars-best-picture-2027' produces only 2 rows (manifold + polymarket)", async () => {
    if (matchingModuleError) {
      throw new Error(`lib/matching.ts not importable: ${matchingModuleError.message}`);
    }

    const query = MATCHING_QUERIES.find((q) => q.slug === "oscars-best-picture-2027")!;
    expect(query, "oscars-best-picture-2027 not found in matching-queries.yaml").toBeDefined();

    await matchQuestion(FIXTURE_USER_ID, query.id, query.query_text);
    const rows = getMatchRows(query.id);

    expect(
      rows.length,
      `Expected 2 rows for "Oscars best picture 2027" ` +
        `(manifold + polymarket only, per tests/fixtures/wire/README.md) ` +
        `but found ${rows.length}. ` +
        `Platforms found: ${rows.map((r) => r.platform).join(", ")}. ` +
        `When a platform returns an empty fixture, matchQuestion must NOT insert a row.`
    ).toBe(2);

    const platforms = rows.map((r) => r.platform).sort();
    expect(platforms).toEqual(["manifold", "polymarket"].sort());
  });

  it("matchQuestion invokes wireRequest with userId for each platform call", async () => {
    if (matchingModuleError) {
      throw new Error(`lib/matching.ts not importable: ${matchingModuleError.message}`);
    }

    // Verify that lib/wire/client.ts's recorded calls used the fixture user id
    // (i.e. matchQuestion passed userId to wireRequest, which called recordWireCall).
    const { clearWireCalls, getLastWireCall } = await import("../../lib/wire/fixtures.js");
    clearWireCalls();

    const query = FOUR_PLATFORM_QUERIES[0];
    await matchQuestion(FIXTURE_USER_ID, query.id, query.query_text);

    const lastCall = getLastWireCall();
    expect(
      lastCall,
      `No Wire calls were recorded. matchQuestion must call wireRequest(userId, action, params). ` +
        `lib/wire/fixtures.ts recordWireCall() is invoked by the client in fixture mode.`
    ).toBeDefined();

    // The auth header must contain "Bearer " (key was decrypted and used)
    expect(
      lastCall!.authHeader.startsWith("Bearer "),
      `Last recorded Wire call has authHeader="${lastCall!.authHeader}". ` +
        `Expected it to start with "Bearer ". ` +
        `matchQuestion must pass userId to wireRequest, which decrypts the key on-demand ` +
        `(ADR-0002 §"Per-call credential injection").`
    ).toBe(true);

    // The plaintext key must not be "undefined" or empty
    const tokenPart = lastCall!.authHeader.slice("Bearer ".length);
    expect(
      tokenPart.length > 0 && tokenPart !== "undefined",
      `Auth header token is "${tokenPart}". ` +
        `The decrypted key must be a non-empty string — ` +
        `check that getDecryptedAnakinKey returns the fixture key correctly.`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DoD 3: Field-mapping verification (per ADR-0002 JSON paths)
// ---------------------------------------------------------------------------

describe("DoD 3 — Field-mapping verification (ADR-0002 JSON paths)", () => {
  it("lib/wire/mapping.ts exports extractImpliedYesProb", () => {
    expect(
      mappingModuleError,
      `lib/wire/mapping.ts does not exist or fails to import. ` +
        `Error: ${mappingModuleError?.message}. ` +
        `Create lib/wire/mapping.ts and export: ` +
        `extractImpliedYesProb(platform: string, payload: unknown): number | null`
    ).toBeNull();

    expect(
      typeof extractImpliedYesProb,
      "extractImpliedYesProb is not a function. lib/wire/mapping.ts must export it."
    ).toBe("function");
  });

  // Kalshi (kl_events) — paths: markets[i].yes_bid, markets[i].yes_ask, markets[i].last_price
  // Values in cents (0-100); mapper divides by 100.
  it("Kalshi fixture 'fed-cuts-rates-june-2026': yes_bid and yes_ask resolve to cents in [0,100]", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "tests/fixtures/wire/kl_events/fed-cuts-rates-june-2026.json"),
        "utf8"
      )
    );

    const market = (fixture.markets as Array<Record<string, unknown>>)[0];
    expect(
      market,
      `tests/fixtures/wire/kl_events/fed-cuts-rates-june-2026.json: ` +
        `"markets" array is empty or missing. ADR-0002: Kalshi path is markets[i].yes_bid.`
    ).toBeDefined();

    const yesBid = market["yes_bid"] as number;
    const yesAsk = market["yes_ask"] as number;
    const lastPrice = market["last_price"] as number;

    expect(
      typeof yesBid === "number",
      `Kalshi fixture "fed-cuts-rates-june-2026": markets[0].yes_bid is not a number (got ${typeof yesBid}). ` +
        `ADR-0002 §"Field mapping per platform": Kalshi path to YES bid = markets[i].yes_bid.`
    ).toBe(true);

    expect(
      typeof yesAsk === "number",
      `Kalshi fixture: markets[0].yes_ask is not a number (got ${typeof yesAsk}). ` +
        `ADR-0002: Kalshi path to YES ask = markets[i].yes_ask.`
    ).toBe(true);

    expect(
      typeof lastPrice === "number",
      `Kalshi fixture: markets[0].last_price is not a number (got ${typeof lastPrice}). ` +
        `ADR-0002: Kalshi path to last YES trade = markets[i].last_price.`
    ).toBe(true);

    // Values must be in cents [0, 100]
    for (const [name, val] of [["yes_bid", yesBid], ["yes_ask", yesAsk], ["last_price", lastPrice]] as [string, number][]) {
      expect(
        val >= 0 && val <= 100,
        `Kalshi fixture markets[0].${name}=${val} is outside [0, 100] cents range. ` +
          `ADR-0002: Kalshi quotes in cents; mapper divides by 100.`
      ).toBe(true);
    }
  });

  it("Kalshi fixture 'fed-cuts-rates-june-2026': extractImpliedYesProb returns midpoint (0.43)", () => {
    if (mappingModuleError) {
      throw new Error(`lib/wire/mapping.ts not importable: ${mappingModuleError.message}`);
    }

    const fixture = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "tests/fixtures/wire/kl_events/fed-cuts-rates-june-2026.json"),
        "utf8"
      )
    );

    const prob = extractImpliedYesProb("kalshi", fixture);

    expect(
      prob,
      `extractImpliedYesProb("kalshi", fixture) returned ${prob} but expected ~0.43. ` +
        `ADR-0002 midpoint convention: (yes_bid + yes_ask) / 2 in cents = (42 + 44) / 2 = 43 cents → 0.43. ` +
        `Mapper must divide by 100 to convert cents to probability.`
    ).not.toBeNull();

    expect(
      Math.abs(prob! - 0.43) < 0.001,
      `Kalshi implied_yes_prob=${prob}, expected 0.43 (±0.001). ` +
        `Midpoint of yes_bid=42 and yes_ask=44 in cents = 43 cents = 0.43.`
    ).toBe(true);
  });

  // Manifold (mm_search_markets) — path: markets[i].probability
  // Manifold AMM: bid == ask == midpoint == probability; value in [0, 1].
  it("Manifold fixture 'fed-cuts-rates-june-2026': probability resolves to a [0,1] number", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "tests/fixtures/wire/mm_search_markets/fed-cuts-rates-june-2026.json"),
        "utf8"
      )
    );

    const market = (fixture.markets as Array<Record<string, unknown>>)[0];
    expect(
      market,
      `tests/fixtures/wire/mm_search_markets/fed-cuts-rates-june-2026.json: ` +
        `"markets" array is empty or missing. ADR-0002: Manifold path is markets[i].probability.`
    ).toBeDefined();

    const probability = market["probability"] as number;

    expect(
      typeof probability === "number",
      `Manifold fixture markets[0].probability is not a number (got ${typeof probability}). ` +
        `ADR-0002 §"Field mapping per platform": Manifold path = markets[i].probability.`
    ).toBe(true);

    expect(
      probability >= 0 && probability <= 1,
      `Manifold fixture markets[0].probability=${probability} is outside [0, 1]. ` +
        `Manifold reports probability in [0, 1] — no unit conversion needed.`
    ).toBe(true);
  });

  it("Manifold fixture 'fed-cuts-rates-june-2026': extractImpliedYesProb returns 0.45", () => {
    if (mappingModuleError) {
      throw new Error(`lib/wire/mapping.ts not importable: ${mappingModuleError.message}`);
    }

    const fixture = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "tests/fixtures/wire/mm_search_markets/fed-cuts-rates-june-2026.json"),
        "utf8"
      )
    );

    const prob = extractImpliedYesProb("manifold", fixture);

    expect(prob, `extractImpliedYesProb("manifold", fixture) returned null. Expected 0.45.`).not.toBeNull();

    expect(
      Math.abs(prob! - 0.45) < 0.001,
      `Manifold implied_yes_prob=${prob}, expected 0.45 (±0.001). ` +
        `Manifold probability field = 0.45; bid == ask == midpoint.`
    ).toBe(true);
  });

  // Polymarket (pm_get_events) — paths: events[i].markets[j].outcomes[YES].bid/ask/last_trade_price
  // YES identified by outcomes[*].name === "Yes"; values in [0, 1].
  it("Polymarket fixture 'fed-cuts-rates-june-2026': YES outcome bid/ask/last_trade_price resolve to [0,1] numbers", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "tests/fixtures/wire/pm_get_events/fed-cuts-rates-june-2026.json"),
        "utf8"
      )
    );

    const event = (fixture.events as Array<Record<string, unknown>>)[0];
    expect(
      event,
      `tests/fixtures/wire/pm_get_events/fed-cuts-rates-june-2026.json: ` +
        `"events" array is empty or missing. ADR-0002: Polymarket path is events[i].markets[j].outcomes[YES].bid.`
    ).toBeDefined();

    const markets = event["markets"] as Array<Record<string, unknown>>;
    expect(markets?.[0], "pm fixture events[0].markets[0] is missing").toBeDefined();

    const outcomes = markets[0]["outcomes"] as Array<Record<string, unknown>>;
    const yesOutcome = outcomes?.find((o) => o["name"] === "Yes");

    expect(
      yesOutcome,
      `Polymarket fixture: no outcome with name="Yes" found in events[0].markets[0].outcomes. ` +
        `ADR-0002: YES outcome identified by outcomes[*].name === "Yes" (capital Y, lowercase es). ` +
        `Found names: ${JSON.stringify(outcomes?.map((o) => o["name"]))}`
    ).toBeDefined();

    for (const field of ["bid", "ask", "last_trade_price"]) {
      const val = yesOutcome![field] as number;
      expect(
        typeof val === "number",
        `Polymarket fixture YES outcome.${field} is not a number (got ${typeof val}). ` +
          `ADR-0002: Polymarket paths use .bid, .ask, .last_trade_price on the YES outcome.`
      ).toBe(true);

      expect(
        val >= 0 && val <= 1,
        `Polymarket fixture YES outcome.${field}=${val} is outside [0, 1]. ` +
          `Polymarket values are already in [0, 1]; no unit conversion needed.`
      ).toBe(true);
    }
  });

  it("Polymarket fixture 'fed-cuts-rates-june-2026': extractImpliedYesProb returns midpoint (0.40)", () => {
    if (mappingModuleError) {
      throw new Error(`lib/wire/mapping.ts not importable: ${mappingModuleError.message}`);
    }

    const fixture = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "tests/fixtures/wire/pm_get_events/fed-cuts-rates-june-2026.json"),
        "utf8"
      )
    );

    const prob = extractImpliedYesProb("polymarket", fixture);

    expect(prob, `extractImpliedYesProb("polymarket", fixture) returned null. Expected 0.40.`).not.toBeNull();

    expect(
      Math.abs(prob! - 0.40) < 0.001,
      `Polymarket implied_yes_prob=${prob}, expected 0.40 (±0.001). ` +
        `Midpoint of YES bid=0.39 and ask=0.41 = 0.40.`
    ).toBe(true);
  });

  // Robinhood (rh_get_events) — paths: events[i].contracts[YES].bid_price/ask_price/last_trade_price
  // YES identified by contracts[*].side === "yes" (all lowercase); values in [0, 1].
  it("Robinhood fixture 'fed-cuts-rates-june-2026': YES contract bid_price/ask_price/last_trade_price resolve to [0,1] numbers", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "tests/fixtures/wire/rh_get_events/fed-cuts-rates-june-2026.json"),
        "utf8"
      )
    );

    const event = (fixture.events as Array<Record<string, unknown>>)[0];
    expect(
      event,
      `tests/fixtures/wire/rh_get_events/fed-cuts-rates-june-2026.json: ` +
        `"events" array is empty or missing. ADR-0002: Robinhood path is events[i].contracts[YES].bid_price.`
    ).toBeDefined();

    const contracts = event["contracts"] as Array<Record<string, unknown>>;
    const yesContract = contracts?.find((c) => c["side"] === "yes");

    expect(
      yesContract,
      `Robinhood fixture: no contract with side="yes" found in events[0].contracts. ` +
        `ADR-0002: YES contract identified by contracts[*].side === "yes" (all lowercase). ` +
        `Found sides: ${JSON.stringify(contracts?.map((c) => c["side"]))}`
    ).toBeDefined();

    for (const field of ["bid_price", "ask_price", "last_trade_price"]) {
      const val = yesContract![field] as number;
      expect(
        typeof val === "number",
        `Robinhood fixture YES contract.${field} is not a number (got ${typeof val}). ` +
          `ADR-0002: Robinhood paths use .bid_price, .ask_price, .last_trade_price on the YES contract.`
      ).toBe(true);

      expect(
        val >= 0 && val <= 1,
        `Robinhood fixture YES contract.${field}=${val} is outside [0, 1]. ` +
          `Robinhood values are in [0, 1]; no unit conversion needed.`
      ).toBe(true);
    }
  });

  it("Robinhood fixture 'fed-cuts-rates-june-2026': extractImpliedYesProb returns midpoint (0.43)", () => {
    if (mappingModuleError) {
      throw new Error(`lib/wire/mapping.ts not importable: ${mappingModuleError.message}`);
    }

    const fixture = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "tests/fixtures/wire/rh_get_events/fed-cuts-rates-june-2026.json"),
        "utf8"
      )
    );

    const prob = extractImpliedYesProb("robinhood", fixture);

    expect(prob, `extractImpliedYesProb("robinhood", fixture) returned null. Expected 0.43.`).not.toBeNull();

    expect(
      Math.abs(prob! - 0.43) < 0.001,
      `Robinhood implied_yes_prob=${prob}, expected 0.43 (±0.001). ` +
        `Midpoint of YES bid_price=0.42 and ask_price=0.44 = 0.43.`
    ).toBe(true);
  });

  it("fallback to last-trade when bid/ask are absent (extractImpliedYesProb fallback chain)", () => {
    if (mappingModuleError) {
      throw new Error(`lib/wire/mapping.ts not importable: ${mappingModuleError.message}`);
    }

    // Construct a Kalshi payload where yes_bid and yes_ask are absent
    // but last_price is present. Per ADR-0002 the fallback must apply.
    const noQuotePayload = {
      markets: [
        {
          market_id: "KL-TEST-NO-QUOTE",
          title: "Test market — no bid/ask",
          status: "open",
          last_price: 65, // cents
        }
      ]
    };

    const prob = extractImpliedYesProb("kalshi", noQuotePayload);

    expect(
      prob,
      `extractImpliedYesProb returned null for a Kalshi payload that has last_price=65 ` +
        `but no yes_bid/yes_ask. ADR-0002: fallback to last YES trade price when quote is absent. ` +
        `Expected 0.65 (65 cents / 100).`
    ).not.toBeNull();

    expect(
      Math.abs(prob! - 0.65) < 0.001,
      `Kalshi last-trade fallback: expected prob=0.65 (65 cents / 100) but got ${prob}. ` +
        `ADR-0002 fallback chain: if bid/ask absent → use last_price.`
    ).toBe(true);
  });

  it("returns null when bid/ask AND last-trade are all absent", () => {
    if (mappingModuleError) {
      throw new Error(`lib/wire/mapping.ts not importable: ${mappingModuleError.message}`);
    }

    const noDataPayload = {
      markets: [
        {
          market_id: "KL-TEST-NO-DATA",
          title: "Test market — no price data",
          status: "open",
        }
      ]
    };

    const prob = extractImpliedYesProb("kalshi", noDataPayload);

    expect(
      prob,
      `extractImpliedYesProb must return null when bid/ask and last-trade are all absent. ` +
        `ADR-0002: "Else return null. The match is dropped from the spread calculation for that tick." ` +
        `Got: ${prob}`
    ).toBeNull();
  });

  it("spread between platforms for 'fed-cuts-rates-june-2026' is 5pp (0.05)", () => {
    if (mappingModuleError) {
      throw new Error(`lib/wire/mapping.ts not importable: ${mappingModuleError.message}`);
    }

    const platforms = [
      { name: "kalshi", action: "kl_events" },
      { name: "manifold", action: "mm_search_markets" },
      { name: "polymarket", action: "pm_get_events" },
      { name: "robinhood", action: "rh_get_events" },
    ] as const;

    const probs: number[] = [];

    for (const { name, action } of platforms) {
      const fixture = JSON.parse(
        readFileSync(
          join(
            REPO_ROOT,
            `tests/fixtures/wire/${action}/fed-cuts-rates-june-2026.json`
          ),
          "utf8"
        )
      );
      const prob = extractImpliedYesProb(name, fixture);
      expect(
        prob,
        `extractImpliedYesProb("${name}", fixture) returned null for "fed-cuts-rates-june-2026". ` +
          `All 4 platform fixtures have complete bid/ask data for this query.`
      ).not.toBeNull();
      probs.push(prob!);
    }

    const spread = Math.max(...probs) - Math.min(...probs);

    expect(
      Math.abs(spread - 0.05) < 0.001,
      `Cross-platform spread for "fed-cuts-rates-june-2026" is ${spread.toFixed(4)} ` +
        `but expected ~0.05 (5pp). ` +
        `Expected probs: kalshi=0.43, manifold=0.45, polymarket=0.40, robinhood=0.43. ` +
        `max=0.45, min=0.40, spread=0.05.`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DoD 4: ≥3 of 5 queries match on all 4 platforms
// ---------------------------------------------------------------------------

describe("DoD 4 — ≥3 of 5 seeded queries match all 4 platforms", () => {
  it("at least 3 of the 5 seeded queries have non-null matches on each of the 4 platforms", async () => {
    if (matchingModuleError) {
      throw new Error(`lib/matching.ts not importable: ${matchingModuleError.message}`);
    }

    const resultsPerQuery: Array<{ query: MatchingQuery; platforms: string[] }> = [];

    for (const query of MATCHING_QUERIES) {
      await matchQuestion(FIXTURE_USER_ID, query.id, query.query_text);
      const rows = getMatchRows(query.id);
      resultsPerQuery.push({ query, platforms: rows.map((r) => r.platform) });
    }

    const fullCoverageCount = resultsPerQuery.filter(({ platforms }) =>
      ALL_PLATFORMS.every((p) => platforms.includes(p))
    ).length;

    expect(
      fullCoverageCount >= 3,
      `Only ${fullCoverageCount} of ${MATCHING_QUERIES.length} queries matched all 4 platforms. ` +
        `DoD requirement: "matching finds markets across all 4 platforms for ≥3 of 5 seeded queries". ` +
        `Results: ${JSON.stringify(
          resultsPerQuery.map(({ query, platforms }) => ({
            slug: query.slug,
            platforms,
          })),
          null,
          2
        )}`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DoD 5: Key-error pass-through
// ---------------------------------------------------------------------------

describe("DoD 5 — Key-error pass-through (missing / invalid key)", () => {
  it("matchQuestion throws WireError with class='key-missing' when user has no key", async () => {
    if (matchingModuleError) {
      throw new Error(`lib/matching.ts not importable: ${matchingModuleError.message}`);
    }

    const { WireError } = await import("../../lib/wire/errors.js");

    const NO_KEY_USER_ID = "00000000-0000-0000-0000-000000000002"; // fixture_user_no_key from queries.yaml
    const query = MATCHING_QUERIES[0];

    let threw = false;
    let thrownError: unknown;

    try {
      await matchQuestion(NO_KEY_USER_ID, query.id, query.query_text);
    } catch (err) {
      threw = true;
      thrownError = err;
    }

    expect(
      threw,
      `matchQuestion did not throw when called with a user that has no Anakin key (id="${NO_KEY_USER_ID}"). ` +
        `ADR-0002 §"Error taxonomy": key-missing must propagate as WireError({ class: "key-missing" }). ` +
        `matchQuestion must not silently swallow key errors.`
    ).toBe(true);

    expect(
      thrownError instanceof WireError,
      `matchQuestion threw ${thrownError} (type=${typeof thrownError}) but expected a WireError. ` +
        `ADR-0002: Wire failures are tagged as WireError with a machine-readable class.`
    ).toBe(true);

    expect(
      (thrownError as InstanceType<typeof WireError>).class,
      `WireError.class is "${(thrownError as InstanceType<typeof WireError>).class}" ` +
        `but expected "key-missing". ` +
        `ADR-0002 §"Error taxonomy": a missing anakin_key_ct must produce class="key-missing".`
    ).toBe("key-missing");
  });

  it("no question_matches rows are persisted when matchQuestion throws key-missing", async () => {
    if (matchingModuleError) {
      throw new Error(`lib/matching.ts not importable: ${matchingModuleError.message}`);
    }

    const NO_KEY_USER_ID = "00000000-0000-0000-0000-000000000002";
    const query = MATCHING_QUERIES[0];

    try {
      await matchQuestion(NO_KEY_USER_ID, query.id, query.query_text);
    } catch {
      // Expected throw — we only care about DB state
    }

    const rows = getMatchRows(query.id);

    expect(
      rows.length,
      `Found ${rows.length} rows in question_matches for question_id="${query.id}" ` +
        `after a key-missing error. matchQuestion must not persist any partial rows ` +
        `when the user's key is unavailable (no partial writes on error).`
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DoD 6: Idempotent re-match (upsert, no duplicate rows)
// ---------------------------------------------------------------------------

describe("DoD 6 — Idempotent re-match (upsert, not insert)", () => {
  it("calling matchQuestion twice for the same (user, question) does not duplicate rows", async () => {
    if (matchingModuleError) {
      throw new Error(`lib/matching.ts not importable: ${matchingModuleError.message}`);
    }

    const query = FOUR_PLATFORM_QUERIES[0];

    await matchQuestion(FIXTURE_USER_ID, query.id, query.query_text);
    await matchQuestion(FIXTURE_USER_ID, query.id, query.query_text);

    const rows = getMatchRows(query.id);

    expect(
      rows.length,
      `After calling matchQuestion twice for question_id="${query.id}", ` +
        `found ${rows.length} rows but expected ${query.expected_platforms.length}. ` +
        `matchQuestion must UPSERT on (question_id, platform) conflict key — ` +
        `not INSERT a duplicate row. ` +
        `SQL: INSERT INTO question_matches (...) ON CONFLICT (question_id, platform) DO UPDATE SET ...`
    ).toBe(query.expected_platforms.length);
  });

  it("second call updates last_seen_at timestamp (upsert refreshes, not no-ops)", async () => {
    if (matchingModuleError) {
      throw new Error(`lib/matching.ts not importable: ${matchingModuleError.message}`);
    }

    const query = FOUR_PLATFORM_QUERIES[0];

    await matchQuestion(FIXTURE_USER_ID, query.id, query.query_text);
    const firstRows = getMatchRows(query.id);
    const firstTimestamps = new Map(firstRows.map((r) => [r.platform, r.last_seen_at]));

    // Wait 1ms to ensure timestamp can differ
    await new Promise((resolve) => setTimeout(resolve, 1));

    await matchQuestion(FIXTURE_USER_ID, query.id, query.query_text);
    const secondRows = getMatchRows(query.id);

    for (const row of secondRows) {
      const firstTs = firstTimestamps.get(row.platform);
      // last_seen_at must be ≥ first call's timestamp (upsert updated it)
      expect(
        row.last_seen_at !== null && row.last_seen_at !== undefined,
        `Row platform="${row.platform}" has null last_seen_at after second call. ` +
          `matchQuestion must set last_seen_at on every upsert.`
      ).toBe(true);

      // We tolerate equal (same millisecond) but not older
      if (firstTs != null && row.last_seen_at != null) {
        expect(
          row.last_seen_at >= firstTs,
          `Row platform="${row.platform}": last_seen_at went backward ` +
            `(first=${firstTs}, second=${row.last_seen_at}). ` +
            `Upsert must update last_seen_at to now() on each call.`
        ).toBe(true);
      }
    }
  });

  it("upsert conflict key is (question_id, platform) — schema must have a UNIQUE constraint on this pair", () => {
    try {
      // Attempt to directly insert two rows with the same (question_id, platform).
      // If the UNIQUE constraint exists, the second insert must throw.
      const questionId = FOUR_PLATFORM_QUERIES[0].id;

      sqlite
        .prepare(
          `INSERT INTO question_matches (id, question_id, platform, market_id, last_seen_at)
           VALUES ('test-upsert-1', ?, 'kalshi', 'MKT-A', unixepoch())`
        )
        .run(questionId);

      let duplicateThrew = false;
      try {
        sqlite
          .prepare(
            `INSERT INTO question_matches (id, question_id, platform, market_id, last_seen_at)
             VALUES ('test-upsert-2', ?, 'kalshi', 'MKT-B', unixepoch())`
          )
          .run(questionId);
      } catch {
        duplicateThrew = true;
      } finally {
        sqlite
          .prepare(`DELETE FROM question_matches WHERE question_id = ? AND platform = 'kalshi'`)
          .run(questionId);
      }

      expect(
        duplicateThrew,
        `Inserting two rows with the same (question_id="${questionId}", platform="kalshi") ` +
          `succeeded — no UNIQUE constraint exists. ` +
          `db/schema.ts must define a UNIQUE constraint on question_matches(question_id, platform) ` +
          `so that ON CONFLICT DO UPDATE works correctly.`
      ).toBe(true);
    } catch (err) {
      // Table doesn't exist yet — expected pre-implementation
      throw new Error(
        `question_matches table does not exist: ${(err as Error).message}. ` +
          `db/schema.ts must add this table with a UNIQUE constraint on (question_id, platform).`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// DoD: Schema shape assertion (expected table structure)
// ---------------------------------------------------------------------------

describe("Schema — question_matches table existence and shape", () => {
  it("question_matches table exists in the DB", () => {
    try {
      const row = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='question_matches'"
        )
        .get() as { name: string } | undefined;

      expect(
        row,
        `Table "question_matches" does not exist in the database. ` +
          `db/schema.ts must add this table. Suggested Drizzle schema:\n` +
          `export const questionMatches = sqliteTable("question_matches", {\n` +
          `  id: text("id").primaryKey(),\n` +
          `  questionId: text("question_id").notNull().references(() => watchedQuestions.id),\n` +
          `  platform: text("platform", { enum: ["kalshi","manifold","polymarket","robinhood"] }).notNull(),\n` +
          `  marketId: text("market_id").notNull(),\n` +
          `  marketUrl: text("market_url"),\n` +
          `  impliedYesProb: real("implied_yes_prob"),\n` +
          `  lastSeenAt: integer("last_seen_at", { mode: "timestamp" }).notNull(),\n` +
          `}, (t) => [unique().on(t.questionId, t.platform)]);`
      ).toBeDefined();
    } catch (err) {
      throw new Error(
        `Failed to query sqlite_master: ${(err as Error).message}. ` +
          `The question_matches table must be created via a Drizzle migration.`
      );
    }
  });

  it("question_matches has the required columns: id, question_id, platform, market_id, implied_yes_prob, last_seen_at", () => {
    try {
      const cols = sqlite
        .prepare("PRAGMA table_info(question_matches)")
        .all() as Array<{ name: string; type: string; notnull: number }>;

      const colNames = cols.map((c) => c.name);

      for (const required of ["id", "question_id", "platform", "market_id", "implied_yes_prob", "last_seen_at"]) {
        expect(
          colNames.includes(required),
          `question_matches is missing column "${required}". ` +
            `Found columns: ${JSON.stringify(colNames)}. ` +
            `ADR-0002 task brief: required shape is ` +
            `(question_id FK watched_questions, platform enum, market_id, market_url, implied_yes_prob, last_seen_at).`
        ).toBe(true);
      }
    } catch (err) {
      throw new Error(
        `Cannot inspect question_matches columns: ${(err as Error).message}.`
      );
    }
  });
});
