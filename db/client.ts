import { AsyncLocalStorage } from "node:async_hooks";

/**
 * In test environments (NODE_ENV=test), the setup file runs each request in
 * an AsyncLocalStorage context carrying the DATABASE_URL for that request.
 * This allows concurrent test suites to use different DBs without races on
 * process.env.DATABASE_URL.
 */
export const testDbUrlStore = new AsyncLocalStorage<string>();

function getUrl(): string {
  return (
    testDbUrlStore.getStore() ??
    process.env.DATABASE_URL ??
    "file:./local.db"
  );
}

const _isNeon = getUrl().startsWith("postgres");

// ---------------------------------------------------------------------------
// Neon path
// ---------------------------------------------------------------------------

let _neonDb: ReturnType<typeof import("drizzle-orm/neon-http").drizzle> | undefined;
let _neonSql: ReturnType<typeof import("@neondatabase/serverless").neon> | undefined;

function getNeonClients() {
  if (!_neonDb || !_neonSql) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { neon } = require("@neondatabase/serverless") as typeof import("@neondatabase/serverless");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { drizzle: drizzleNeon } = require("drizzle-orm/neon-http") as typeof import("drizzle-orm/neon-http");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pgSchema = require("./schema.pg") as typeof import("./schema.pg");
    const url = getUrl();
    _neonSql = neon(url);
    _neonDb = drizzleNeon(_neonSql, { schema: pgSchema });
  }
  return { neonDb: _neonDb!, neonSql: _neonSql! };
}

// ---------------------------------------------------------------------------
// SQLite path (dev / tests)
// ---------------------------------------------------------------------------

import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { statSync } from "node:fs";
import * as sqliteSchema from "./schema";

interface DbEntry {
  sqlite: InstanceType<typeof Database>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  ino: number | null;
  walIno: number | null;
  shmIno: number | null;
}

const _dbCache = new Map<string, DbEntry>();

function fileIno(filePath: string): number | null {
  try {
    return statSync(filePath).ino;
  } catch {
    return null;
  }
}

function openEntry(url: string): DbEntry {
  const filePath = url.startsWith("file:") ? url.slice(5) : url;
  const sqliteInstance = new Database(filePath);
  sqliteInstance.pragma("journal_mode = WAL");
  // Apply incremental schema migrations
  try { sqliteInstance.exec("ALTER TABLE question_matches ADD COLUMN close_date TEXT"); } catch { /* column already exists */ }
  const db = drizzleSqlite(sqliteInstance, { schema: sqliteSchema });
  const ino = fileIno(filePath);
  const walIno = fileIno(filePath + "-wal");
  const shmIno = fileIno(filePath + "-shm");
  return { sqlite: sqliteInstance, db, ino, walIno, shmIno };
}

function entryIsValid(entry: DbEntry, url: string): boolean {
  if (!entry.sqlite.open) return false;
  const filePath = url.startsWith("file:") ? url.slice(5) : url;
  const currentIno = fileIno(filePath);
  if (currentIno === null) return true;
  if (entry.ino !== currentIno) return false;
  const walPath = filePath + "-wal";
  const shmPath = filePath + "-shm";
  const walIno = fileIno(walPath);
  const shmIno = fileIno(shmPath);
  if (entry.walIno !== null && walIno !== entry.walIno) return false;
  if (entry.shmIno !== null && shmIno !== entry.shmIno) return false;
  if (entry.walIno === null && walIno !== null) return false;
  if (entry.shmIno === null && shmIno !== null) return false;
  return true;
}

function getSqliteEntry(): DbEntry {
  const url = getUrl();
  const cached = _dbCache.get(url);
  if (cached && entryIsValid(cached, url)) {
    return cached;
  }
  if (cached) {
    try { cached.sqlite.close(); } catch { /* ignore */ }
    _dbCache.delete(url);
  }
  const entry = openEntry(url);
  _dbCache.set(url, entry);
  return entry;
}

export function getDb() {
  if (_isNeon) {
    return getNeonClients().neonDb;
  }
  return getSqliteEntry().db;
}

// ---------------------------------------------------------------------------
// Unified exports
// ---------------------------------------------------------------------------

// Backward-compat singleton export — uses getDb() so it picks up the right DB at call time
export const db = new Proxy(
  {} as ReturnType<typeof drizzleSqlite>,
  {
    get(_target, prop) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (getDb() as any)[prop];
    },
  }
);

// SQLite proxy for test files and legacy code that imports `sqlite` directly.
// In Neon mode this will be a proxy over an empty object — tests only run locally with SQLite.
export const sqlite = new Proxy({} as InstanceType<typeof Database>, {
  get(_target, prop) {
    if (_isNeon) return undefined;
    const url = getUrl();
    const entry = _dbCache.get(url);
    if (!entry || !entryIsValid(entry, url)) {
      getSqliteEntry();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (_dbCache.get(url)?.sqlite as any)?.[prop];
  },
});

/**
 * Unified async tagged-template query function.
 *
 * Usage:  const rows = await rawQuery`SELECT * FROM users WHERE id = ${userId}`
 *
 * - Neon mode:   delegates directly to neon's sql tagged template
 * - SQLite mode: converts to ?-parameterized SQL, runs .all(), returns plain objects
 */
export async function rawQuery<T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<T[]> {
  if (_isNeon) {
    const { neonSql } = getNeonClients();
    // neon's tagged template returns rows directly
    return (await neonSql(strings, ...values)) as T[];
  }

  // SQLite: build ?-parameterized SQL
  let sqlStr = "";
  strings.forEach((s, i) => {
    sqlStr += s;
    if (i < values.length) sqlStr += "?";
  });
  const entry = getSqliteEntry();
  const stmt = entry.sqlite.prepare(sqlStr);
  // Use .run() for statements that don't return rows (INSERT/UPDATE/DELETE/...)
  if (stmt.reader) {
    const rows = stmt.all(...values);
    return Promise.resolve(rows as T[]);
  }
  stmt.run(...values);
  return Promise.resolve([] as T[]);
}
