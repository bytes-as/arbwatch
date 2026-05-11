import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { statSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import * as schema from "./schema";

/**
 * In test environments (NODE_ENV=test), the setup file runs each request in
 * an AsyncLocalStorage context carrying the DATABASE_URL for that request.
 * This allows concurrent test suites to use different DBs without races on
 * process.env.DATABASE_URL.
 */
export const testDbUrlStore = new AsyncLocalStorage<string>();

// ---------------------------------------------------------------------------
// Per-URL connection cache (URL → {sqlite, db, ino})
// ---------------------------------------------------------------------------

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
  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  // Apply incremental schema migrations
  try { sqlite.exec("ALTER TABLE question_matches ADD COLUMN close_date TEXT"); } catch { /* column already exists */ }
  const db = drizzle(sqlite, { schema });
  const ino = fileIno(filePath);
  const walIno = fileIno(filePath + "-wal");
  const shmIno = fileIno(filePath + "-shm");
  return { sqlite, db, ino, walIno, shmIno };
}

function entryIsValid(entry: DbEntry, url: string): boolean {
  if (!entry.sqlite.open) return false;
  const filePath = url.startsWith("file:") ? url.slice(5) : url;
  const currentIno = fileIno(filePath);
  // If we can't stat the file, keep the existing connection (might be deleted
  // but still accessible via fd — not a test scenario we need to handle)
  if (currentIno === null) return true;
  if (entry.ino !== currentIno) return false;
  // Health check: detect stale WAL/SHM state that occurs when the seed script
  // deleted and recreated the WAL file while this connection was open.
  // Reconnect if:
  //   - A WAL/SHM file existed when we opened the connection and now it's gone
  //     (seed deleted it and may not have recreated it yet)
  //   - A WAL/SHM file exists now but has a different inode than when we opened
  //     (seed deleted and recreated it)
  const walPath = filePath + "-wal";
  const shmPath = filePath + "-shm";
  const walIno = fileIno(walPath);
  const shmIno = fileIno(shmPath);
  // If we had a WAL/SHM when we opened, check if it's still the same file.
  // A null walIno here means the file was deleted (or never existed).
  if (entry.walIno !== null && walIno !== entry.walIno) return false;
  if (entry.shmIno !== null && shmIno !== entry.shmIno) return false;
  if (entry.walIno === null && walIno !== null) return false;
  if (entry.shmIno === null && shmIno !== null) return false;
  return true;
}

/**
 * Returns a Drizzle ORM client connected to the database at the URL from:
 * 1. AsyncLocalStorage (per-request in test mode)
 * 2. process.env.DATABASE_URL
 * 3. Fallback "file:./local.db"
 *
 * Caches connections per URL + inode, so same-URL requests reuse the connection.
 * Detects file replacement (via inode) and reconnects automatically.
 */
export function getDb() {
  const url =
    testDbUrlStore.getStore() ??
    process.env.DATABASE_URL ??
    "file:./local.db";

  const cached = _dbCache.get(url);
  if (cached && entryIsValid(cached, url)) {
    return cached.db;
  }

  // Close stale entry if it exists
  if (cached) {
    try {
      cached.sqlite.close();
    } catch {
      // ignore
    }
    _dbCache.delete(url);
  }

  const entry = openEntry(url);
  _dbCache.set(url, entry);
  return entry.db;
}

// Backward-compat singleton export — uses getDb() so it picks up the right DB at call time
export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, prop) {
    return (getDb() as any)[prop];
  },
});

export const sqlite = new Proxy({} as InstanceType<typeof Database>, {
  get(_target, prop) {
    const url =
      testDbUrlStore.getStore() ??
      process.env.DATABASE_URL ??
      "file:./local.db";
    const entry = _dbCache.get(url);
    if (!entry || !entryIsValid(entry, url)) {
      getDb(); // triggers initialization
    }
    return (_dbCache.get(url)?.sqlite as any)?.[prop];
  },
});
