/**
 * tests/skeleton/seed.test.ts
 *
 * Mode 1 (pre-implementation) — these tests MUST FAIL until the seed script
 * and Drizzle schema are implemented.
 *
 * Surfaces:
 *   (b) Seed populates the DB with exactly 3 test questions (from tests/seeds/queries.yaml)
 *   (b) Seed populates the DB with exactly 1 fixture user
 *   (b) The fixture user has anakin_key_status = "ok"
 *   (b) The fixture user has a non-null anakin_key_ct (encrypted key stored)
 *
 * Strategy:
 *   1. Run the seed script against a throwaway SQLite file.
 *   2. Open the same file with better-sqlite3 and query the tables directly.
 *   3. Assert row counts and column values.
 *
 * The seed script is expected at scripts/seed.ts (run via `npx tsx` or the
 * project's script runner).  The DB schema is applied by the seed script itself
 * (via drizzle-kit push or an inline migrate call) before inserting rows.
 *
 * IMPLEMENTATION NOTE for the implementer:
 *   - `scripts/seed.ts` must accept DATABASE_URL from the environment.
 *   - The fixture user's id must be "00000000-0000-0000-0000-000000000001"
 *     (matches tests/seeds/queries.yaml) so the watched_question FK resolves.
 *   - The 3 question ids and query_text values must match tests/seeds/queries.yaml
 *     exactly (id columns used for idempotency in the preview.sh idempotency test).
 *   - anakin_key_ct must be a non-null Buffer/Uint8Array with at least 29 bytes
 *     (12-byte nonce + at least 1 byte ciphertext + 16-byte tag = 29 minimum).
 *   - anakin_key_status must be the string "ok".
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const SEED_SCRIPT = join(REPO_ROOT, "scripts", "seed.ts");
const FIXTURE_USER_ID = "00000000-0000-0000-0000-000000000001";
const FIXTURE_USER_EMAIL = "fixture@predmkt-arb.test";
const EXPECTED_QUESTION_IDS = [
  "10000000-0000-0000-0000-000000000001",
  "10000000-0000-0000-0000-000000000002",
  "10000000-0000-0000-0000-000000000003",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A deterministic test encryption key: 32 zero bytes encoded as base64. */
const TEST_APP_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function makeTempDbPath(): string {
  const dir = join(tmpdir(), "predmkt-arb-tests");
  mkdirSync(dir, { recursive: true });
  return join(dir, `seed-test-${process.pid}.db`);
}

/**
 * Run the seed script in a child process with a dedicated SQLite file.
 * Returns the path to the DB file.
 * Throws if the script exits non-zero.
 */
function runSeed(dbPath: string): void {
  // The seed script is TypeScript; run via tsx (or ts-node, whichever the
  // implementer wires up).  We try tsx first (faster), then ts-node as fallback.
  const env = {
    ...process.env,
    DATABASE_URL: `file:${dbPath}`,
    WIRE_MODE: "fixtures",
    APP_ENCRYPTION_KEY: TEST_APP_ENCRYPTION_KEY,
    NODE_ENV: "test",
  };

  // This call will throw (ENOENT or non-zero exit) until the script exists —
  // which is the desired Mode 1 failure mode.
  execFileSync("npx", ["tsx", SEED_SCRIPT], {
    env,
    cwd: REPO_ROOT,
    stdio: "pipe",
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Seed script — database population", () => {
  let dbPath: string;
  // We import better-sqlite3 lazily inside tests so the error is an assertion
  // failure rather than a module-load crash when the dep is absent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    dbPath = makeTempDbPath();

    // Run seed — this is the step that fails in Mode 1 because scripts/seed.ts
    // does not exist yet.
    runSeed(dbPath);

    // Open the resulting DB with better-sqlite3
    // This import will also fail in Mode 1 if better-sqlite3 is not installed.
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    db = new BetterSqlite3(dbPath, { readonly: true });
  });

  afterAll(() => {
    if (db) db.close();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  // ---- User assertions ----

  it("seeds exactly 1 user row", () => {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM users").get() as { cnt: number };
    expect(row.cnt).toBe(1);
  });

  it("fixture user has the expected id", () => {
    const row = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
    expect(row.id).toBe(FIXTURE_USER_ID);
  });

  it("fixture user has the expected email", () => {
    const row = db
      .prepare("SELECT email FROM users WHERE id = ?")
      .get(FIXTURE_USER_ID) as { email: string } | undefined;
    expect(row).not.toBeUndefined();
    expect(row!.email).toBe(FIXTURE_USER_EMAIL);
  });

  it('fixture user has anakin_key_status = "ok"', () => {
    const row = db
      .prepare("SELECT anakin_key_status FROM users WHERE id = ?")
      .get(FIXTURE_USER_ID) as { anakin_key_status: string } | undefined;
    expect(row).not.toBeUndefined();
    expect(row!.anakin_key_status).toBe("ok");
  });

  it("fixture user has a non-null anakin_key_ct (encrypted key stored)", () => {
    const row = db
      .prepare("SELECT anakin_key_ct FROM users WHERE id = ?")
      .get(FIXTURE_USER_ID) as { anakin_key_ct: Buffer | null } | undefined;
    expect(row).not.toBeUndefined();
    expect(row!.anakin_key_ct).not.toBeNull();
    // nonce(12) + min 1 byte ciphertext + tag(16) = 29 bytes minimum
    expect((row!.anakin_key_ct as Buffer).length).toBeGreaterThanOrEqual(29);
  });

  // ---- Question assertions ----

  it("seeds exactly 3 watched_question rows", () => {
    const row = db
      .prepare("SELECT COUNT(*) as cnt FROM watched_questions")
      .get() as { cnt: number };
    expect(row.cnt).toBe(3);
  });

  it("all 3 questions belong to the fixture user", () => {
    const rows = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM watched_questions WHERE user_id = ?"
      )
      .get(FIXTURE_USER_ID) as { cnt: number };
    expect(rows.cnt).toBe(3);
  });

  it("question ids match tests/seeds/queries.yaml exactly", () => {
    const rows = db
      .prepare(
        "SELECT id FROM watched_questions ORDER BY id"
      )
      .all() as { id: string }[];
    const actualIds = rows.map((r) => r.id).sort();
    expect(actualIds).toEqual([...EXPECTED_QUESTION_IDS].sort());
  });

  it("question texts are non-empty strings", () => {
    const rows = db
      .prepare("SELECT query_text FROM watched_questions")
      .all() as { query_text: string }[];
    for (const row of rows) {
      expect(typeof row.query_text).toBe("string");
      expect(row.query_text.length).toBeGreaterThan(0);
    }
  });
});
