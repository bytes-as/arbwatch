/**
 * tests/key/helpers/db-inspect.ts
 *
 * Thin wrapper around better-sqlite3 for inspecting the test SQLite file
 * directly in key-storage tests.  All functions are synchronous (better-sqlite3
 * is synchronous by design) and read-only.
 *
 * The implementer must ensure DATABASE_URL is set to a SQLite path before
 * these tests run.  The seed script (scripts/seed.ts) must apply the schema
 * (drizzle-kit push or inline migrate) before inserting rows.
 *
 * Usage:
 *   const db = openTestDb();
 *   const row = getUser(db, FIXTURE_USER_ID);
 *   db.close();
 */

import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  email: string;
  anakin_key_ct: Buffer | null;
  anakin_key_status: string | null;
  anakin_key_status_at: string | null;
}

// ---------------------------------------------------------------------------
// DB path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the test SQLite file from DATABASE_URL.
 * DATABASE_URL must be of the form "file:<path>" for SQLite.
 * Throws if the env var is absent or does not use the file: scheme.
 */
export function resolveDbPath(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. " +
        "The test environment must set DATABASE_URL=file:<path> so db-inspect.ts " +
        "can open the SQLite file directly."
    );
  }
  if (!url.startsWith("file:")) {
    throw new Error(
      `DATABASE_URL="${url}" does not use the file: scheme. ` +
        "db-inspect.ts only supports SQLite (file:) connections."
    );
  }
  // Strip the "file:" prefix to get the raw path.
  // drizzle / better-sqlite3 both accept the bare path.
  return url.slice("file:".length);
}

// ---------------------------------------------------------------------------
// DB open / close
// ---------------------------------------------------------------------------

/**
 * Open the test SQLite DB in read-write mode (tests that write need this).
 * The caller is responsible for calling db.close() in afterAll.
 *
 * This import will fail in Mode 1 if better-sqlite3 is not installed — which
 * is an expected failure signal for the implementer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function openTestDb(dbPath?: string): Promise<any> {
  const path = dbPath ?? resolveDbPath();
  // Dynamic import so the module load does not crash if better-sqlite3 is absent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import("better-sqlite3")) as any;
  const BetterSqlite3 = mod.default ?? mod;
  return new BetterSqlite3(path);
}

// ---------------------------------------------------------------------------
// User queries
// ---------------------------------------------------------------------------

/** Fetch a single user row by id. Returns undefined if not found. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getUser(db: any, userId: string): UserRow | undefined {
  return db
    .prepare(
      "SELECT id, email, anakin_key_ct, anakin_key_status, anakin_key_status_at " +
        "FROM users WHERE id = ?"
    )
    .get(userId) as UserRow | undefined;
}

/**
 * Return the raw bytes stored in users.anakin_key_ct for a given user.
 * Returns null if the column is NULL (key not set).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getAnakinKeyCt(db: any, userId: string): Buffer | null {
  const row = db
    .prepare("SELECT anakin_key_ct FROM users WHERE id = ?")
    .get(userId) as { anakin_key_ct: Buffer | null } | undefined;
  if (!row) throw new Error(`User ${userId} not found in DB`);
  return row.anakin_key_ct;
}

/** Return the value of users.anakin_key_status for a given user. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getAnakinKeyStatus(db: any, userId: string): string | null {
  const row = db
    .prepare("SELECT anakin_key_status FROM users WHERE id = ?")
    .get(userId) as { anakin_key_status: string | null } | undefined;
  if (!row) throw new Error(`User ${userId} not found in DB`);
  return row.anakin_key_status;
}

/** Return the value of users.anakin_key_status_at for a given user. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getAnakinKeyStatusAt(db: any, userId: string): string | null {
  const row = db
    .prepare("SELECT anakin_key_status_at FROM users WHERE id = ?")
    .get(userId) as { anakin_key_status_at: string | null } | undefined;
  if (!row) throw new Error(`User ${userId} not found in DB`);
  return row.anakin_key_status_at;
}

// ---------------------------------------------------------------------------
// Enum integrity probe
// ---------------------------------------------------------------------------

/**
 * Attempt to write an arbitrary string to users.anakin_key_status.
 * Returns true if the write succeeded (bad — the enum constraint is missing),
 * returns false / throws if the DB rejected it (good — constraint is enforced).
 *
 * This helper is used by the enum-integrity test to assert that the schema
 * enforces the allowed values at the column level.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tryWriteInvalidStatus(db: any, userId: string, badValue: string): boolean {
  try {
    db.prepare("UPDATE users SET anakin_key_status = ? WHERE id = ?").run(
      badValue,
      userId
    );
    // If we get here the write succeeded — the constraint is absent.
    return true;
  } catch {
    // The DB threw a constraint violation — enum integrity is enforced.
    return false;
  }
}
