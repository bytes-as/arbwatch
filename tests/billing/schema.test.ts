/**
 * tests/billing/schema.test.ts
 *
 * Mode 1 (pre-implementation) — ALL tests in this file MUST FAIL until:
 *   - db/schema.ts users table gains a `plan` TEXT column with default 'free'
 *   - db/schema.ts users table gains a `stripe_customer_id` TEXT nullable column
 *   - A CHECK constraint enforces plan IN ('free', 'paid')
 *   - scripts/seed.ts seeds the fixture user with plan='free'
 *   - A migration is generated and applied
 *
 * DoD items covered:
 *   BILL-SCH-1 — users table has a `plan` column of type TEXT
 *   BILL-SCH-2 — seeded users have plan='free' by default
 *   BILL-SCH-3 — stripe_customer_id column exists and is NULL on a fresh seeded user
 *   BILL-SCH-4 — CHECK constraint rejects plan values other than 'free'|'paid'
 *
 * Test approach:
 *   - BILL-SCH-1, BILL-SCH-2, BILL-SCH-3 each use their own temp DB seeded via
 *     scripts/seed.ts so that column-presence and default-value assertions are
 *     independent and do not share state.
 *   - BILL-SCH-4 uses a beforeAll-scoped temp DB; it attempts an INSERT with an
 *     invalid plan value and asserts that SQLite throws due to the CHECK constraint.
 *   - All seeds use WIRE_MODE=fixtures so no external network calls are made.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const SEED_SCRIPT = join(REPO_ROOT, "scripts", "seed.ts");
const TEST_APP_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

// ---------------------------------------------------------------------------
// Temp DB helper (mirrors embedding.test.ts pattern)
// ---------------------------------------------------------------------------

function makeTempDbPath(suffix: string): string {
  const dir = join(tmpdir(), "predmkt-arb-billing-tests");
  mkdirSync(dir, { recursive: true });
  return join(dir, `billing-${suffix}-${process.pid}.db`);
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
// BILL-SCH-1 — users table has a `plan` column of type TEXT
// ---------------------------------------------------------------------------

describe("BILL-SCH-1 — users.plan column exists and is TEXT", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("sch1");
    runSeed(dbPath);
    // Database constructor takes a raw file path, not a file: URI
    sqlite = new Database(dbPath.startsWith("file:") ? dbPath.slice(5) : dbPath);
    sqlite.pragma("journal_mode = WAL");
  });

  afterAll(() => {
    sqlite?.close();
  });

  it("users table has a 'plan' column of TEXT type", () => {
    const cols = sqlite
      .prepare("PRAGMA table_info(users)")
      .all() as Array<{ name: string; type: string; dflt_value: string | null; notnull: number }>;

    const col = cols.find((c) => c.name === "plan");

    expect(
      col,
      `Column 'plan' is missing from the users table. ` +
        `Add it to db/schema.ts as: plan: text("plan").notNull().default("free"). ` +
        `Then run 'npx drizzle-kit generate' and apply the migration.`
    ).toBeDefined();

    expect(
      col?.type?.toUpperCase(),
      `Column 'plan' has type '${col?.type}', expected 'TEXT'. ` +
        `Declare it with text("plan") in drizzle-orm/sqlite-core.`
    ).toBe("TEXT");
  });
});

// ---------------------------------------------------------------------------
// BILL-SCH-2 — seeded users have plan='free' by default
// ---------------------------------------------------------------------------

describe("BILL-SCH-2 — seeded user has plan='free' by default", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("sch2");
    runSeed(dbPath);
    sqlite = new Database(dbPath.startsWith("file:") ? dbPath.slice(5) : dbPath);
    sqlite.pragma("journal_mode = WAL");
  });

  afterAll(() => {
    sqlite?.close();
  });

  it("the seeded fixture user row has plan='free'", () => {
    const rows = sqlite
      .prepare("SELECT id, plan FROM users LIMIT 10")
      .all() as Array<{ id: string; plan: string | null }>;

    expect(
      rows.length,
      `No rows found in the users table after seeding. ` +
        `Verify that scripts/seed.ts inserts at least one user.`
    ).toBeGreaterThan(0);

    for (const row of rows) {
      expect(
        row.plan,
        `User '${row.id}' has plan='${row.plan}', expected 'free'. ` +
          `Set the column default: plan: text("plan").notNull().default("free") in db/schema.ts. ` +
          `Ensure scripts/seed.ts does not override the plan column explicitly.`
      ).toBe("free");
    }
  });
});

// ---------------------------------------------------------------------------
// BILL-SCH-3 — stripe_customer_id column exists and is NULL on fresh seeded user
// ---------------------------------------------------------------------------

describe("BILL-SCH-3 — users.stripe_customer_id column exists and is NULL after seed", () => {
  let dbPath: string;
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    dbPath = makeTempDbPath("sch3");
    runSeed(dbPath);
    sqlite = new Database(dbPath.startsWith("file:") ? dbPath.slice(5) : dbPath);
    sqlite.pragma("journal_mode = WAL");
  });

  afterAll(() => {
    sqlite?.close();
  });

  it("users table has a 'stripe_customer_id' column", () => {
    const cols = sqlite
      .prepare("PRAGMA table_info(users)")
      .all() as Array<{ name: string; type: string; dflt_value: string | null; notnull: number }>;

    const col = cols.find((c) => c.name === "stripe_customer_id");

    expect(
      col,
      `Column 'stripe_customer_id' is missing from the users table. ` +
        `Add it to db/schema.ts as: stripeCustomerId: text("stripe_customer_id"). ` +
        `Then run 'npx drizzle-kit generate' and apply the migration.`
    ).toBeDefined();
  });

  it("the seeded fixture user has stripe_customer_id=NULL", () => {
    const rows = sqlite
      .prepare("SELECT id, stripe_customer_id FROM users LIMIT 10")
      .all() as Array<{ id: string; stripe_customer_id: string | null }>;

    expect(
      rows.length,
      `No rows found in the users table after seeding. ` +
        `Verify that scripts/seed.ts inserts at least one user.`
    ).toBeGreaterThan(0);

    for (const row of rows) {
      expect(
        row.stripe_customer_id,
        `User '${row.id}' has stripe_customer_id='${row.stripe_customer_id}', expected NULL. ` +
          `The stripe_customer_id column must be nullable and default to NULL for new users. ` +
          `Do not populate it during seed.`
      ).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// BILL-SCH-4 — CHECK constraint rejects plan values other than 'free'|'paid'
// ---------------------------------------------------------------------------

describe("BILL-SCH-4 — CHECK constraint rejects invalid plan values", () => {
  let sqlite: InstanceType<typeof Database>;

  beforeAll(() => {
    const dbPath = makeTempDbPath("sch4");
    runSeed(dbPath);
    sqlite = new Database(dbPath.startsWith("file:") ? dbPath.slice(5) : dbPath);
    sqlite.pragma("journal_mode = WAL");
  });

  afterAll(() => {
    sqlite?.close();
  });

  it("INSERT with plan='invalid' throws a CHECK constraint violation", () => {
    expect(
      () => {
        sqlite
          .prepare(
            `INSERT INTO users (id, email, plan, anakin_key_status, created_at)
             VALUES ('test-bad-plan-user', 'badplan@test.invalid', 'invalid', 'key-missing', unixepoch())`
          )
          .run();
      },
      `Expected SQLite to throw a constraint violation when inserting plan='invalid', ` +
        `but no error was thrown. ` +
        `Add a CHECK constraint to db/schema.ts: ` +
        `check("users_plan_check", sql\`\${t.plan} IN ('free', 'paid')\`). ` +
        `Then regenerate the migration.`
    ).toThrow();
  });

  it("INSERT with plan='free' succeeds", () => {
    expect(
      () => {
        sqlite
          .prepare(
            `INSERT INTO users (id, email, plan, anakin_key_status, created_at)
             VALUES ('test-free-plan-user', 'freeplan@test.invalid', 'free', 'key-missing', unixepoch())`
          )
          .run();
      }
    ).not.toThrow();
  });

  it("INSERT with plan='paid' succeeds", () => {
    expect(
      () => {
        sqlite
          .prepare(
            `INSERT INTO users (id, email, plan, anakin_key_status, created_at)
             VALUES ('test-paid-plan-user', 'paidplan@test.invalid', 'paid', 'key-missing', unixepoch())`
          )
          .run();
      }
    ).not.toThrow();
  });
});
