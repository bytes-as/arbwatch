/**
 * tests/server/matching-setup.ts
 *
 * Vitest setupFile for tests/matching/*.test.ts (runs under the "other" project)
 * and tests/cron/*.test.ts (runs under the "cron" project).
 *
 * Seeds the fixture user and the 5 matching-query watched_questions rows into
 * local.db so that lib/matching.ts can insert question_matches rows without FK
 * violations. Runs migrations idempotently so the question_matches table exists.
 *
 * Also registers a beforeEach hook that clears the cron handler's per-invocation
 * idempotency cache (lib/cron.ts#clearIdempotencyCache). This ensures each test
 * starts with a clean idempotency state regardless of prior test runs.
 *
 * Why needed: the "other" workspace project has no setup file, so matching tests
 * depend on the DB being pre-seeded. This setup file provides that guarantee in
 * a repeatable, idempotent way for every test run.
 */

import { beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import yaml from "yaml";

// ---------------------------------------------------------------------------
// Environment defaults
// ---------------------------------------------------------------------------

process.env.APP_ENCRYPTION_KEY =
  process.env.APP_ENCRYPTION_KEY ??
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.NODE_ENV = "test";
process.env.SKIP_CSRF_CHECK = "true";
process.env.WIRE_MODE = process.env.WIRE_MODE ?? "fixtures";

const REPO_ROOT = join(new URL("../../", import.meta.url).pathname).replace(/\/$/, "");

const DB_URL = process.env.DATABASE_URL ?? "file:./local.db";
const DB_FILE = DB_URL.startsWith("file:") ? DB_URL.slice(5) : DB_URL;

// ---------------------------------------------------------------------------
// Open DB and apply migrations
// ---------------------------------------------------------------------------

const sqlite = new Database(DB_FILE);
sqlite.pragma("journal_mode = WAL");
const db = drizzle(sqlite);

migrate(db, { migrationsFolder: join(REPO_ROOT, "drizzle") });

// ---------------------------------------------------------------------------
// Seed fixture users
// ---------------------------------------------------------------------------

const queriesYamlPath = join(REPO_ROOT, "tests", "seeds", "queries.yaml");
const queriesData = yaml.parse(readFileSync(queriesYamlPath, "utf8")) as {
  fixture_user: { id: string; email: string; anakin_key_status: string };
  fixture_user_no_key: { id: string; email: string; anakin_key_status: string };
};

// Primary fixture user — insert with encrypted Anakin key
const { encrypt } = await import("../../db/encryption.js");
const fixtureKey = encrypt(
  "fixture-anakin-key-for-testing-only",
  queriesData.fixture_user.id
);

sqlite
  .prepare(
    `INSERT INTO users (id, email, anakin_key_ct, anakin_key_status, created_at)
     VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       anakin_key_ct = excluded.anakin_key_ct,
       anakin_key_status = excluded.anakin_key_status`
  )
  .run(
    queriesData.fixture_user.id,
    queriesData.fixture_user.email,
    fixtureKey,
    queriesData.fixture_user.anakin_key_status
  );

// No-key fixture user
sqlite
  .prepare(
    `INSERT INTO users (id, email, anakin_key_ct, anakin_key_status, created_at)
     VALUES (?, ?, NULL, ?, unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       anakin_key_ct = NULL,
       anakin_key_status = excluded.anakin_key_status`
  )
  .run(
    queriesData.fixture_user_no_key.id,
    queriesData.fixture_user_no_key.email,
    queriesData.fixture_user_no_key.anakin_key_status
  );

// ---------------------------------------------------------------------------
// Seed matching-query watched_questions rows
// ---------------------------------------------------------------------------

const matchingYamlPath = join(REPO_ROOT, "tests", "seeds", "matching-queries.yaml");
const matchingData = yaml.parse(readFileSync(matchingYamlPath, "utf8")) as {
  matching_questions: Array<{
    id: string;
    query_text: string;
    user_id: string;
  }>;
};

const insertQuestion = sqlite.prepare(
  `INSERT INTO watched_questions (id, user_id, query_text, created_at)
   VALUES (?, ?, ?, unixepoch())
   ON CONFLICT(id) DO NOTHING`
);

for (const q of matchingData.matching_questions) {
  insertQuestion.run(q.id, q.user_id, q.query_text);
}

sqlite.close();

// ---------------------------------------------------------------------------
// Per-test cleanup: clear in-memory caches so each test starts with a fresh
// state regardless of prior test runs.
//   - cron idempotency cache: prevents DoD 10 test 2 from inheriting the
//     processed-question set from DoD 10 test 1.
//   - alerts state cache: allows each it() block in the alerts test suite to
//     independently trigger an alert without carrying over hysteresis state
//     from a prior it() block (the persistent DB state is used for
//     within-test hysteresis between dispatch calls in the same it() block).
// ---------------------------------------------------------------------------

beforeEach(async () => {
  const { clearIdempotencyCache } = await import("../../lib/cron.js");
  clearIdempotencyCache();
  try {
    const { clearAlertsCache } = await import("../../lib/alerts.js");
    clearAlertsCache();
  } catch {
    // lib/alerts.ts may not exist pre-implementation; ignore
  }
});
