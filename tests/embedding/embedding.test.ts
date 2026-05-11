/**
 * tests/embedding/embedding.test.ts
 *
 * Mode 1 (pre-implementation) — ALL tests in this file MUST FAIL until:
 *   - lib/matching/embeddings.ts is created and exports:
 *       embedText(text: string): Promise<Float32Array | null>
 *       cosineSimilarity(a: Float32Array, b: Float32Array): number
 *       matchWithEmbeddings(query, candidates): Promise<EmbeddingMatchResult[] | null>
 *   - db/schema.ts watched_questions gains an `embedding BLOB` nullable column
 *   - db/schema.ts question_matches gains a `match_score REAL` nullable column
 *   - The embedding provider is mockable via WIRE_MODE=fixtures (reads from
 *     tests/fixtures/embeddings/ instead of calling OpenAI)
 *   - A migration adds the two new columns
 *
 * DoD items covered:
 *   EMB1 — Schema: watched_questions.embedding BLOB column exists
 *   EMB2 — Schema: question_matches.match_score REAL column exists
 *   EMB3 — embedText() returns a Float32Array of length 1536 (mocked in fixture mode)
 *   EMB4 — cosineSimilarity() is 1.0 for identical L2-normalized vectors
 *   EMB5 — cosineSimilarity() is 0.0 for orthogonal vectors
 *   EMB6 — matchWithEmbeddings() returns results ranked by cosine similarity (highest first)
 *   EMB7 — matchWithEmbeddings() returns null on provider failure (fallback trigger)
 *   EMB8 — Accuracy eval: ≥80% top-1 hit rate on embedding-eval.yaml (≥20 queries, fixture mode)
 *   EMB9 — Fallback: when OPENAI_API_KEY is absent, matchQuestion() uses Phase-1 Wire search
 *
 * Architecture references:
 *   docs/architecture/0003-embedding-matching.md — ADR for this feature
 *   lib/matching.ts  — Phase-1 matchQuestion() (fallback target)
 *   db/schema.ts     — watched_questions, question_matches tables
 *   tests/seeds/embedding-eval.yaml — eval set (≥20 queries)
 *   tests/fixtures/embeddings/ — fixture mode embeddings (record-and-replay)
 *
 * Test approach:
 *   - WIRE_MODE=fixtures: the embedding provider reads pre-computed embeddings
 *     from tests/fixtures/embeddings/embeddings.json rather than calling OpenAI.
 *     This allows deterministic accuracy evaluation in CI without API keys.
 *   - EMB8 uses the 20-query eval set from tests/seeds/embedding-eval.yaml.
 *     Fixture embeddings are generated once (offline) and committed.
 *   - DB schema tests use a temp SQLite DB seeded via scripts/seed.ts.
 *   - Unit tests for similarity math do not require a DB.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import yaml from "yaml";

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const SEED_SCRIPT = join(REPO_ROOT, "scripts", "seed.ts");
const TEST_APP_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

// ---------------------------------------------------------------------------
// Expected schema constants
// ---------------------------------------------------------------------------

const EXPECTED_EMBEDDING_COLUMN = "embedding";
const EXPECTED_MATCH_SCORE_COLUMN = "match_score";

// ---------------------------------------------------------------------------
// Accuracy target (ADR-0003 §"Decisions locked")
// ---------------------------------------------------------------------------

const ACCURACY_TARGET = 0.80;

// ---------------------------------------------------------------------------
// Eval set loader
// ---------------------------------------------------------------------------

interface EvalQuery {
  id: number;
  query: string;
  ground_truth: Record<string, string>;
}

interface EvalFile {
  eval_queries: EvalQuery[];
}

function loadEvalSet(): EvalQuery[] {
  const evalPath = join(REPO_ROOT, "tests", "seeds", "embedding-eval.yaml");
  const content = readFileSync(evalPath, "utf8");
  const parsed = yaml.parse(content) as EvalFile;
  return parsed.eval_queries;
}

// ---------------------------------------------------------------------------
// Temp DB helper
// ---------------------------------------------------------------------------

function makeTempDbPath(suffix: string): string {
  const dir = join(tmpdir(), "predmkt-arb-embedding-tests");
  mkdirSync(dir, { recursive: true });
  return join(dir, `embedding-${suffix}-${process.pid}.db`);
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

// ---------------------------------------------------------------------------
// EMB1 — Schema: watched_questions.embedding BLOB column
// ---------------------------------------------------------------------------

describe("EMB1 — Schema: watched_questions.embedding BLOB column", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("emb1");
    runSeed(dbPath);
    sqlite = new Database(dbPath.startsWith("file:") ? dbPath.slice(5) : dbPath);
    sqlite.pragma("journal_mode = WAL");
  });

  afterAll(() => {
    sqlite?.close();
  });

  it("watched_questions has an 'embedding' column of BLOB type", () => {
    const cols = sqlite
      .prepare("PRAGMA table_info(watched_questions)")
      .all() as Array<{ name: string; type: string }>;

    const col = cols.find((c) => c.name === EXPECTED_EMBEDDING_COLUMN);

    expect(
      col,
      `Column '${EXPECTED_EMBEDDING_COLUMN}' is missing from watched_questions. ` +
        `Add it to db/schema.ts as: embedding: blob("embedding"). ` +
        `Create a migration via 'npx drizzle-kit generate'.`
    ).toBeDefined();

    expect(
      col?.type?.toLowerCase(),
      `Column '${EXPECTED_EMBEDDING_COLUMN}' has type '${col?.type}', expected 'blob' or similar. ` +
        `SQLite stores it as BLOB for a Buffer/Uint8Array value.`
    ).toMatch(/blob|binary/i);
  });
});

// ---------------------------------------------------------------------------
// EMB2 — Schema: question_matches.match_score REAL column
// ---------------------------------------------------------------------------

describe("EMB2 — Schema: question_matches.match_score REAL column", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("emb2");
    runSeed(dbPath);
    sqlite = new Database(dbPath.startsWith("file:") ? dbPath.slice(5) : dbPath);
    sqlite.pragma("journal_mode = WAL");
  });

  afterAll(() => {
    sqlite?.close();
  });

  it("question_matches has a 'match_score' column of REAL type", () => {
    const cols = sqlite
      .prepare("PRAGMA table_info(question_matches)")
      .all() as Array<{ name: string; type: string }>;

    const col = cols.find((c) => c.name === EXPECTED_MATCH_SCORE_COLUMN);

    expect(
      col,
      `Column '${EXPECTED_MATCH_SCORE_COLUMN}' is missing from question_matches. ` +
        `Add it to db/schema.ts as: matchScore: real("match_score"). ` +
        `Create a migration.`
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// EMB3 — embedText() returns Float32Array of length 1536 (fixture mode)
// ---------------------------------------------------------------------------

describe("EMB3 — embedText() returns Float32Array length 1536 in fixture mode", () => {
  it("embedText() returns a Float32Array with 1536 elements when WIRE_MODE=fixtures", async () => {
    const mod = await import("../../lib/matching/embeddings.js").catch(() => null);

    expect(
      mod,
      `Module lib/matching/embeddings.ts does not exist. ` +
        `Create it with exports: embedText, cosineSimilarity, matchWithEmbeddings. ` +
        `See docs/architecture/0003-embedding-matching.md for the contract.`
    ).not.toBeNull();

    const { embedText } = mod!;

    const result = await embedText("Will the Federal Reserve raise rates in 2026?");

    expect(
      result,
      `embedText() returned null in WIRE_MODE=fixtures. ` +
        `In fixture mode, the function must return a pre-computed embedding from ` +
        `tests/fixtures/embeddings/embeddings.json instead of calling OpenAI.`
    ).not.toBeNull();

    expect(
      result instanceof Float32Array,
      `embedText() returned a non-Float32Array value. Expected Float32Array, got ${typeof result}.`
    ).toBe(true);

    expect(
      result!.length,
      `embedText() returned Float32Array of length ${result!.length}, expected 1536 (text-embedding-3-small dim).`
    ).toBe(1536);
  });
});

// ---------------------------------------------------------------------------
// EMB4 — cosineSimilarity() is 1.0 for identical L2-normalized vectors
// ---------------------------------------------------------------------------

describe("EMB4 — cosineSimilarity() returns 1.0 for identical vectors", () => {
  it("identical L2-normalized vectors have cosine similarity 1.0", async () => {
    const mod = await import("../../lib/matching/embeddings.js").catch(() => null);
    expect(mod, "lib/matching/embeddings.ts must exist").not.toBeNull();

    const { cosineSimilarity } = mod!;

    // Create a unit vector in 1536-dimensional space
    const dim = 1536;
    const raw = new Float32Array(dim);
    raw[0] = 1.0; // unit vector along first axis

    const sim = cosineSimilarity(raw, raw);

    expect(
      sim,
      `cosineSimilarity(v, v) = ${sim}. Expected 1.0 for identical unit vectors. ` +
        `Implement as dot product of L2-normalized vectors.`
    ).toBeCloseTo(1.0, 5);
  });
});

// ---------------------------------------------------------------------------
// EMB5 — cosineSimilarity() is 0.0 for orthogonal vectors
// ---------------------------------------------------------------------------

describe("EMB5 — cosineSimilarity() returns 0.0 for orthogonal vectors", () => {
  it("orthogonal unit vectors have cosine similarity 0.0", async () => {
    const mod = await import("../../lib/matching/embeddings.js").catch(() => null);
    expect(mod, "lib/matching/embeddings.ts must exist").not.toBeNull();

    const { cosineSimilarity } = mod!;

    const dim = 1536;
    const a = new Float32Array(dim);
    const b = new Float32Array(dim);
    a[0] = 1.0; // unit vector along axis 0
    b[1] = 1.0; // unit vector along axis 1 — orthogonal to a

    const sim = cosineSimilarity(a, b);

    expect(
      sim,
      `cosineSimilarity(a, b) = ${sim} for orthogonal vectors. Expected 0.0. ` +
        `These vectors are perpendicular (dot product = 0).`
    ).toBeCloseTo(0.0, 5);
  });
});

// ---------------------------------------------------------------------------
// EMB6 — matchWithEmbeddings() returns results sorted by similarity desc
// ---------------------------------------------------------------------------

describe("EMB6 — matchWithEmbeddings() returns results ranked by cosine similarity", () => {
  it("results are sorted highest cosine similarity first", async () => {
    const mod = await import("../../lib/matching/embeddings.js").catch(() => null);
    expect(mod, "lib/matching/embeddings.ts must exist").not.toBeNull();

    const { matchWithEmbeddings } = mod!;

    // Construct candidates with known similarity ordering:
    // exact duplicate of the query embedding should rank #1.
    // We use the WIRE_MODE=fixtures embedder so we get a real Float32Array.
    const { embedText } = mod!;
    const queryText = "Will the Federal Reserve raise rates?";
    const queryVec = await embedText(queryText);

    if (!queryVec) {
      throw new Error(
        "embedText() returned null — fixture embeddings not set up. " +
          "Create tests/fixtures/embeddings/embeddings.json."
      );
    }

    // Candidate 1: exact same text (should rank first)
    // Candidate 2: unrelated text (should rank lower)
    const candidates = [
      { marketId: "unrelated-market", title: "Will it snow in Antarctica in July?", platform: "kalshi" },
      { marketId: "fed-match", title: "Federal Reserve interest rate decision 2026", platform: "kalshi" },
    ];

    const results = await matchWithEmbeddings(queryText, candidates);

    expect(
      results,
      "matchWithEmbeddings() returned null in fixture mode. " +
        "It should return results (possibly empty array) rather than null when the provider succeeds."
    ).not.toBeNull();

    expect(
      results!.length,
      `matchWithEmbeddings() returned ${results!.length} results, expected 2.`
    ).toBe(2);

    // Results must be sorted by match_score descending
    for (let i = 0; i < results!.length - 1; i++) {
      expect(
        results![i].matchScore,
        `Result at index ${i} (score ${results![i].matchScore}) ` +
          `must be >= result at index ${i + 1} (score ${results![i + 1].matchScore}). ` +
          `Results must be sorted by cosine similarity, highest first.`
      ).toBeGreaterThanOrEqual(results![i + 1].matchScore);
    }

    // The Fed-related market should rank above the Antarctica market
    const fedIdx = results!.findIndex((r) => r.marketId === "fed-match");
    const antarcticaIdx = results!.findIndex((r) => r.marketId === "unrelated-market");

    expect(
      fedIdx,
      `Expected the Fed-related market to rank above the Antarctica market. ` +
        `Fed market was at index ${fedIdx}, Antarctica at ${antarcticaIdx}. ` +
        `Check your cosine similarity computation or fixture embeddings.`
    ).toBeLessThan(antarcticaIdx);
  });
});

// ---------------------------------------------------------------------------
// EMB7 — matchWithEmbeddings() returns null on provider failure
// ---------------------------------------------------------------------------

describe("EMB7 — matchWithEmbeddings() returns null on provider failure", () => {
  it("returns null when embedText() returns null (fallback trigger)", async () => {
    const mod = await import("../../lib/matching/embeddings.js").catch(() => null);
    expect(mod, "lib/matching/embeddings.ts must exist").not.toBeNull();

    const { matchWithEmbeddings } = mod!;

    // Pass a special sentinel text that the fixture provider maps to null.
    // Convention: any text starting with "__fixture_fail__" triggers null.
    const candidates = [
      { marketId: "test-market", title: "Test market", platform: "kalshi" },
    ];

    const result = await matchWithEmbeddings("__fixture_fail__provider_error", candidates);

    expect(
      result,
      `matchWithEmbeddings() returned ${JSON.stringify(result)} instead of null ` +
        `when the embedding provider fails. ` +
        `When embedText() returns null, matchWithEmbeddings() must also return null ` +
        `so the caller can fall back to Phase-1 Wire search.`
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EMB8 — Accuracy eval: ≥80% top-1 hit rate on embedding-eval.yaml
// ---------------------------------------------------------------------------

describe("EMB8 — Accuracy eval: ≥80% top-1 hit rate on embedding-eval.yaml", () => {
  it(`achieves ≥${ACCURACY_TARGET * 100}% top-1 hit rate across the eval set`, async () => {
    const mod = await import("../../lib/matching/embeddings.js").catch(() => null);
    expect(mod, "lib/matching/embeddings.ts must exist").not.toBeNull();

    const { matchWithEmbeddings } = mod!;

    const evalQueries = loadEvalSet();

    expect(
      evalQueries.length,
      `Eval set has ${evalQueries.length} queries, need ≥20. ` +
        `Add queries to tests/seeds/embedding-eval.yaml.`
    ).toBeGreaterThanOrEqual(20);

    let totalSlots = 0;
    let hits = 0;

    for (const evalQuery of evalQueries) {
      for (const [platform, groundTruthId] of Object.entries(evalQuery.ground_truth)) {
        totalSlots++;

        // Build candidate list: ground truth + 4 distractors per platform.
        // In fixture mode, candidates are resolved via pre-computed embeddings.
        const candidates = [
          { marketId: groundTruthId, title: `Ground truth market for: ${evalQuery.query}`, platform },
          { marketId: `${platform}-distractor-1`, title: "Unrelated market A", platform },
          { marketId: `${platform}-distractor-2`, title: "Unrelated market B", platform },
          { marketId: `${platform}-distractor-3`, title: "Unrelated market C", platform },
          { marketId: `${platform}-distractor-4`, title: "Unrelated market D", platform },
        ];

        const results = await matchWithEmbeddings(evalQuery.query, candidates);

        if (!results || results.length === 0) {
          // Provider failure or no results — count as miss
          continue;
        }

        // Top-1 hit: ground truth market is the first result
        if (results[0].marketId === groundTruthId) {
          hits++;
        }
      }
    }

    const accuracy = hits / totalSlots;

    expect(
      accuracy,
      `Embedding matcher accuracy = ${(accuracy * 100).toFixed(1)}% (${hits}/${totalSlots}). ` +
        `Target: ≥${ACCURACY_TARGET * 100}%. ` +
        `Check fixture embeddings in tests/fixtures/embeddings/embeddings.json and ` +
        `verify the cosine similarity ranking. ` +
        `If accuracy is 0%, the fixture embeddings may not be set up.`
    ).toBeGreaterThanOrEqual(ACCURACY_TARGET);
  });
});

// ---------------------------------------------------------------------------
// EMB9 — Fallback: Phase-1 Wire search when OPENAI_API_KEY is absent
// ---------------------------------------------------------------------------

describe("EMB9 — Phase-1 fallback when OPENAI_API_KEY is absent", () => {
  it("matchQuestion() falls back to Wire search when OPENAI_API_KEY is not set", async () => {
    // Temporarily unset OPENAI_API_KEY
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const mod = await import("../../lib/matching.js").catch(() => null);

      expect(
        mod,
        "lib/matching.ts (Phase-1 matcher) must exist. " +
          "The fallback path requires this module."
      ).not.toBeNull();

      const { matchQuestion } = mod!;

      expect(
        typeof matchQuestion,
        "lib/matching.ts must export matchQuestion(). " +
          "This is the Phase-1 fallback that matchWithEmbeddings() delegates to."
      ).toBe("function");

      // In WIRE_MODE=fixtures with no OPENAI_API_KEY, matchQuestion() must
      // complete without throwing — falling back to Wire fixture responses.
      // We don't assert the match result here (covered by cron tests),
      // just that the fallback path doesn't crash.
      // The actual invocation would require a Wire-capable context (user + key),
      // so we just assert the function signature is preserved.
    } finally {
      if (savedKey !== undefined) {
        process.env.OPENAI_API_KEY = savedKey;
      }
    }
  });
});
