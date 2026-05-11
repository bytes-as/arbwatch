import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { sql } from "drizzle-orm";
import yaml from "yaml";
import { encrypt } from "../db/encryption";
import * as schema from "../db/schema";

const isCronTest = process.env.PREDMKT_CRON_TEST === "true";
const isMultiuserTest = process.env.PREDMKT_MULTIUSER_TEST === "true";
const isMatchSeed = process.env.PREDMKT_SEED_MATCHES === "true";

const REPO_ROOT = join(__dirname, "..");

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL ?? "file:./local.db";
const filePath = url.startsWith("file:") ? url.slice(5) : url;

// Remove stale WAL/SHM files from previous runs at the same path so that
// SQLite doesn't try to replay a WAL that belongs to a deleted main DB.
for (const suffix of ["-wal", "-shm"]) {
  const stale = filePath + suffix;
  if (existsSync(stale)) unlinkSync(stale);
}

const sqlite = new Database(filePath);
sqlite.pragma("journal_mode = WAL");
const db = drizzle(sqlite, { schema });

// Apply migrations (idempotent)
migrate(db, { migrationsFolder: join(REPO_ROOT, "drizzle") });

// ---------------------------------------------------------------------------
// Seed data from queries.yaml
// ---------------------------------------------------------------------------

const yamlPath = join(REPO_ROOT, "tests", "seeds", "queries.yaml");
const seedData = yaml.parse(readFileSync(yamlPath, "utf8")) as {
  fixture_user: {
    id: string;
    email: string;
    anakin_key_status: string;
  };
  fixture_user_no_key: {
    id: string;
    email: string;
    anakin_key_status: string;
  };
  fixture_user_b: {
    id: string;
    email: string;
    anakin_key_status: string;
  };
  questions: Array<{
    id: string;
    query_text: string;
    user_id: string;
  }>;
  questions_user_b: Array<{
    id: string;
    query_text: string;
    user_id: string;
  }>;
};

const { fixture_user, fixture_user_no_key, fixture_user_b, questions, questions_user_b } = seedData;

// ---------------------------------------------------------------------------
// Upsert fixture users
// ---------------------------------------------------------------------------

const fixtureKey = encrypt("fixture-anakin-key-for-testing-only", fixture_user.id);

// Primary fixture user — has an Anakin key
// Uses DO UPDATE to restore the correct status on each seed run (enables
// idempotent test setup: running seed after a test that deleted the key
// restores the user to the expected "ok" state).
sqlite
  .prepare(
    `INSERT INTO users (id, email, anakin_key_ct, anakin_key_status, created_at)
     VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       anakin_key_ct = excluded.anakin_key_ct,
       anakin_key_status = excluded.anakin_key_status`
  )
  .run(
    fixture_user.id,
    fixture_user.email,
    fixtureKey,
    fixture_user.anakin_key_status
  );

// Second fixture user (no key) — inserted only when PREDMKT_KEY_TEST=true
// so that tests/key/* have two isolated users while tests/skeleton/* see
// exactly 1 user (the skeleton seed test asserts cnt = 1).
const isKeyTest = process.env.PREDMKT_KEY_TEST === "true";

if (isKeyTest) {
  // Second fixture user — always reset to key-missing so tests start from a
  // known state even if a previous test run saved a key for this user.
  sqlite
    .prepare(
      `INSERT INTO users (id, email, anakin_key_ct, anakin_key_status, created_at)
       VALUES (?, ?, NULL, ?, unixepoch())
       ON CONFLICT(id) DO UPDATE SET
         anakin_key_ct = NULL,
         anakin_key_status = excluded.anakin_key_status`
    )
    .run(
      fixture_user_no_key.id,
      fixture_user_no_key.email,
      fixture_user_no_key.anakin_key_status
    );

  // Session for the second fixture user
  const FIXTURE_SESSION_TOKEN_B =
    process.env.FIXTURE_SESSION_TOKEN_B ??
    "fixture-session-token-b-do-not-use-in-prod";
  const sessionExpiresB = Date.now() + 30 * 24 * 60 * 60 * 1000;

  sqlite
    .prepare(
      `INSERT INTO sessions (sessionToken, userId, expires)
       VALUES (?, ?, ?)
       ON CONFLICT(sessionToken) DO UPDATE SET expires = excluded.expires`
    )
    .run(FIXTURE_SESSION_TOKEN_B, fixture_user_no_key.id, sessionExpiresB);
}

// ---------------------------------------------------------------------------
// Multiuser seed: user B + user B's questions + session for user B
// Only inserted when PREDMKT_MULTIUSER_TEST=true so skeleton/other tests
// still see exactly 1 user and 3 questions.
// ---------------------------------------------------------------------------

if (isMultiuserTest) {
  // Insert user B with their own Anakin key
  const fixtureBKey = encrypt(
    "fixture-anakin-key-user-b-testing-only",
    fixture_user_b.id
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
      fixture_user_b.id,
      fixture_user_b.email,
      fixtureBKey,
      fixture_user_b.anakin_key_status
    );

  // Session for user B (multiuser-specific token, distinct from key-test user B token)
  const SESSION_MULTIUSER_B =
    process.env.FIXTURE_SESSION_TOKEN_MULTIUSER_B ?? "fixture-session-token-multiuser-b";
  const sessionExpiresMB = Date.now() + 30 * 24 * 60 * 60 * 1000;

  sqlite
    .prepare(
      `INSERT INTO sessions (sessionToken, userId, expires)
       VALUES (?, ?, ?)
       ON CONFLICT(sessionToken) DO UPDATE SET expires = excluded.expires`
    )
    .run(SESSION_MULTIUSER_B, fixture_user_b.id, sessionExpiresMB);

  // Insert user B's questions
  const insertBQuestion = sqlite.prepare(
    `INSERT INTO watched_questions (id, user_id, query_text, created_at)
     VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(id) DO NOTHING`
  );

  for (const q of questions_user_b) {
    insertBQuestion.run(q.id, q.user_id, q.query_text);
  }

}

// ---------------------------------------------------------------------------
// Upsert fixture session (for redirect-when-authenticated Playwright tests)
// ---------------------------------------------------------------------------

// This session token is used by redirect-when-authenticated.spec.ts to inject
// a pre-seeded authenticated session without going through the magic-link flow.
const FIXTURE_SESSION_TOKEN =
  process.env.FIXTURE_SESSION_TOKEN ?? "fixture-session-token-do-not-use-in-prod";
// expires 30 days from now in milliseconds (timestamp_ms mode)
const sessionExpires = Date.now() + 30 * 24 * 60 * 60 * 1000;

sqlite
  .prepare(
    `INSERT INTO sessions (sessionToken, userId, expires)
     VALUES (?, ?, ?)
     ON CONFLICT(sessionToken) DO UPDATE SET expires = excluded.expires`
  )
  .run(FIXTURE_SESSION_TOKEN, fixture_user.id, sessionExpires);

// ---------------------------------------------------------------------------
// Reset watched questions for fixture users
//
// Delete all watched_questions that are NOT in the baseline seed set.
// This ensures idempotency: running seed after Playwright tests that added
// questions (e.g. cap-reached tests) resets the fixture user to exactly the
// expected baseline (3 questions). Without this reset, accumulated test
// questions would cause watched Playwright tests to see more than 3 questions
// on startup, breaking counter assertions like "3 / 5 watched".
// ---------------------------------------------------------------------------

const seedQuestionIds = questions.map((q) => `'${q.id}'`).join(", ");
const fixtureUserIds = [fixture_user.id];

for (const userId of fixtureUserIds) {
  sqlite
    .prepare(
      `DELETE FROM watched_questions
       WHERE user_id = ? AND id NOT IN (${seedQuestionIds})`
    )
    .run(userId);
}

// ---------------------------------------------------------------------------
// Upsert watched questions
// ---------------------------------------------------------------------------

const insertQuestion = sqlite.prepare(
  `INSERT INTO watched_questions (id, user_id, query_text, created_at)
   VALUES (?, ?, ?, unixepoch())
   ON CONFLICT(id) DO NOTHING`
);

for (const q of questions) {
  insertQuestion.run(q.id, q.user_id, q.query_text);
}

// ---------------------------------------------------------------------------
// Cron test seed: matching questions + no-key user
// Only inserted when PREDMKT_CRON_TEST=true so that skeleton tests still
// see exactly 3 watched_questions and 1 user.
// ---------------------------------------------------------------------------

if (isCronTest) {
  // Insert the no-key user so cron tests can assert per-user skip behavior
  sqlite
    .prepare(
      `INSERT INTO users (id, email, anakin_key_ct, anakin_key_status, created_at)
       VALUES (?, ?, NULL, ?, unixepoch())
       ON CONFLICT(id) DO UPDATE SET
         anakin_key_ct = NULL,
         anakin_key_status = excluded.anakin_key_status`
    )
    .run(
      fixture_user_no_key.id,
      fixture_user_no_key.email,
      fixture_user_no_key.anakin_key_status
    );

  // Session for the no-key user so history tests can verify 404 cross-user isolation.
  const FIXTURE_SESSION_TOKEN_B =
    process.env.FIXTURE_SESSION_TOKEN_B ??
    "fixture-session-token-b-do-not-use-in-prod";
  const sessionExpiresCronB = Date.now() + 30 * 24 * 60 * 60 * 1000;
  sqlite
    .prepare(
      `INSERT INTO sessions (sessionToken, userId, expires)
       VALUES (?, ?, ?)
       ON CONFLICT(sessionToken) DO UPDATE SET expires = excluded.expires`
    )
    .run(FIXTURE_SESSION_TOKEN_B, fixture_user_no_key.id, sessionExpiresCronB);

  // Insert the 5 matching questions (IDs 20000000-...) needed by cron tests
  const matchingYamlPath = join(REPO_ROOT, "tests", "seeds", "matching-queries.yaml");
  const matchingData = yaml.parse(readFileSync(matchingYamlPath, "utf8")) as {
    matching_questions: Array<{
      id: string;
      query_text: string;
      user_id: string;
    }>;
  };

  const insertMatchingQuestion = sqlite.prepare(
    `INSERT INTO watched_questions (id, user_id, query_text, created_at)
     VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(id) DO NOTHING`
  );

  for (const q of matchingData.matching_questions) {
    insertMatchingQuestion.run(q.id, q.user_id, q.query_text);
  }

}

// Seed question_matches for matching questions — only when PREDMKT_SEED_MATCHES=true.
// Cron tests insert their own matches per-describe-block; this flag is only needed
// for history tests (DoD #2) which rely on the cron finding matches to write history rows.
if (isMatchSeed) {
  const insertMatch = sqlite.prepare(
    `INSERT OR REPLACE INTO question_matches
       (id, question_id, platform, market_id, market_url, implied_yes_prob, last_seen_at)
     VALUES (?, ?, ?, ?, NULL, ?, unixepoch())`
  );

  const matchingSeed: Array<{ qId: string; platform: string; marketId: string; prob: number }> = [
    // fed-cuts-rates-june-2026 (all 4 platforms)
    { qId: "20000000-0000-0000-0000-000000000001", platform: "kalshi",     marketId: "KL-FED",  prob: 0.43 },
    { qId: "20000000-0000-0000-0000-000000000001", platform: "manifold",   marketId: "MM-FED",  prob: 0.45 },
    { qId: "20000000-0000-0000-0000-000000000001", platform: "polymarket", marketId: "PM-FED",  prob: 0.40 },
    { qId: "20000000-0000-0000-0000-000000000001", platform: "robinhood",  marketId: "RH-FED",  prob: 0.43 },
    // presidential-election-2028
    { qId: "20000000-0000-0000-0000-000000000002", platform: "kalshi",     marketId: "KL-PRES", prob: 0.50 },
    { qId: "20000000-0000-0000-0000-000000000002", platform: "manifold",   marketId: "MM-PRES", prob: 0.52 },
    { qId: "20000000-0000-0000-0000-000000000002", platform: "polymarket", marketId: "PM-PRES", prob: 0.48 },
    { qId: "20000000-0000-0000-0000-000000000002", platform: "robinhood",  marketId: "RH-PRES", prob: 0.51 },
    // nfl-superbowl-lx
    { qId: "20000000-0000-0000-0000-000000000003", platform: "kalshi",     marketId: "KL-NFL",  prob: 0.30 },
    { qId: "20000000-0000-0000-0000-000000000003", platform: "manifold",   marketId: "MM-NFL",  prob: 0.33 },
    { qId: "20000000-0000-0000-0000-000000000003", platform: "polymarket", marketId: "PM-NFL",  prob: 0.28 },
    { qId: "20000000-0000-0000-0000-000000000003", platform: "robinhood",  marketId: "RH-NFL",  prob: 0.31 },
    // nyc-mayor-2025 (2 platforms)
    { qId: "20000000-0000-0000-0000-000000000004", platform: "kalshi",     marketId: "KL-NYC",  prob: 0.60 },
    { qId: "20000000-0000-0000-0000-000000000004", platform: "polymarket", marketId: "PM-NYC",  prob: 0.58 },
    // oscars-best-picture-2027 (2 platforms)
    { qId: "20000000-0000-0000-0000-000000000005", platform: "manifold",   marketId: "MM-OSC",  prob: 0.20 },
    { qId: "20000000-0000-0000-0000-000000000005", platform: "polymarket", marketId: "PM-OSC",  prob: 0.22 },
  ];

  for (const m of matchingSeed) {
    const matchId = `seed-${m.qId.slice(-4)}-${m.platform.slice(0, 2)}`;
    insertMatch.run(matchId, m.qId, m.platform, m.marketId, m.prob);
  }
}

// ---------------------------------------------------------------------------
// Multiuser question_matches: seed after all questions are inserted so FK holds.
// ---------------------------------------------------------------------------

if (isMultiuserTest) {
  const insertMatch = sqlite.prepare(
    `INSERT INTO question_matches
       (id, question_id, platform, market_id, market_url, implied_yes_prob, last_seen_at)
     VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT (question_id, platform) DO NOTHING`
  );

  const allMultiuserQuestions = [
    ...questions.map((q) => q.id),
    ...questions_user_b.map((q) => q.id),
  ];

  for (const qId of allMultiuserQuestions) {
    insertMatch.run(qId, "kalshi", `kalshi-${qId}`, null, 0.45);
    insertMatch.run(qId, "manifold", `manifold-${qId}`, null, 0.50);
  }
}

// ---------------------------------------------------------------------------
// IPC: write the current DATABASE_URL to a temp file so the in-process
// Vitest key-test setup can pick it up and update process.env.DATABASE_URL.
// Only done when PREDMKT_KEY_TEST=true.
// ---------------------------------------------------------------------------

if (isKeyTest) {
  const ipcFile = join(tmpdir(), ".predmkt-test-current-db-url");
  writeFileSync(ipcFile, url, "utf8");
}

sqlite.close();
console.log("Seed complete.");
